const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { AxeBuilder } = require("@axe-core/playwright");
const { checkWCAGCompliance } = require("./WCAG/rules");

const REPORT_DIR = path.join(__dirname, "reports");
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR);

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Impact ordering for sorting 
const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

// WCAG Level detection from tags 
function getWcagLevel(tags) {
  if (!tags || !Array.isArray(tags)) return "A";
  if (tags.some((t) => t === "wcag2aaa")) return "AAA";
  if (tags.some((t) => t === "wcag2aa")) return "AA";
  return "A";
}

//  Main
(async () => {
  const url = process.argv[2] || "https://news.ycombinator.com/";
  console.log(`\n Scanning: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  try {
    console.log("   Loading page…");
    await page.goto(url, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(2000);
  } catch {
    console.log("   Page load timed out — proceeding with partial scan.");
  }

  //  Step 1: Extract every visible element + metadata 
  console.log("   Extracting DOM elements…");
  const elements = await page.$$eval("*", (els) =>
    els
      .map((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;

        // Build a unique CSS selector for matching with axe results
        let selector = el.tagName.toLowerCase();
        if (el.id) selector += `#${el.id}`;
        else if (el.className && typeof el.className === "string")
          selector += "." + el.className.trim().split(/\s+/).join(".");

        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          classes: typeof el.className === "string" ? el.className : "",
          text: (el.innerText || "").trim().substring(0, 120),
          alt: el.getAttribute("alt"),
          type: el.getAttribute("type") || "",
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          title: el.getAttribute("title") || "",
          lang: el.getAttribute("lang") || "",
          tabindex: el.getAttribute("tabindex"),
          placeholder: el.getAttribute("placeholder") || "",
          href: el.getAttribute("href") || "",
          htmlSnippet: el.outerHTML.substring(0, 200),
          selectorTypes: [
            el.id ? "ID" : "",
            el.className ? "Class" : "",
            el.getAttribute("role") ? "Role" : "",
            el.innerText ? "Text" : "",
            "XPath",
          ].filter(Boolean),
          selector: selector,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        };
      })
      .filter(Boolean)
  );

  console.log(`    Found ${elements.length} visible elements`);

  //  Step 2: Run axe-core 
  console.log("   Running axe-core audit…");
  let axeResults;
  try {
    axeResults = await new AxeBuilder({ page }).analyze();
  } catch (err) {
    console.log("   axe-core error:", err.message);
    axeResults = { violations: [] };
  }

  console.log(`    axe-core found ${axeResults.violations.length} rule violations`);

  //  Step 2b: Resolve bounding boxes for ALL axe violation nodes 
  console.log("   Resolving element positions for axe violations…");
  const axeSelectors = [];
  axeResults.violations.forEach((rule) => {
    rule.nodes.forEach((node) => {
      const sel = node.target && node.target[0] ? node.target[0] : "";
      if (sel) axeSelectors.push(sel);
    });
  });

  // Batch-resolve all bounding boxes in one page.evaluate call
  const axeRects = await page.evaluate((selectors) => {
    return selectors.map((sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || "").trim().substring(0, 120),
          selectorTypes: [
            el.id ? "ID" : "",
            el.className ? "Class" : "",
            el.getAttribute("role") ? "Role" : "",
            el.innerText ? "Text" : "",
            "XPath",
          ].filter(Boolean),
        };
      } catch {
        return null;
      }
    });
  }, axeSelectors);

  // Build a lookup map: selector → resolved rect+info
  const axeRectMap = {};
  axeSelectors.forEach((sel, i) => {
    if (axeRects[i]) axeRectMap[sel] = axeRects[i];
  });

  //Step 3: Run custom rules
  console.log("   Running custom WCAG rules…");
  const customIssues = checkWCAGCompliance(elements);
  console.log(`    Custom rules found ${customIssues.length} issues`);

  // Step 4: Merge into a unified violations list 
  console.log("   Merging results…");
  const violations = [];

  // 4a  Process axe-core violations
  axeResults.violations.forEach((rule) => {
    const dequeLink = rule.helpUrl || `https://dequeuniversity.com/rules/axe/4.11/${rule.id}`;
    rule.nodes.forEach((node) => {
      const selector = node.target && node.target[0] ? node.target[0] : "";
      const snippet = (node.html || "").substring(0, 200);

      // Use the resolved rect from the live page 
      const resolved = selector ? axeRectMap[selector] : null;

      // Fallback: try matching with our extracted elements
      let matchedElement = null;
      if (!resolved && selector) {
        matchedElement = elements.find((el) => {
          if (el.id && selector === `#${el.id}`) return true;
          if (selector === el.selector) return true;
          return false;
        });
      }

      const finalRect = resolved
        ? { x: resolved.x, y: resolved.y, w: resolved.w, h: resolved.h }
        : matchedElement
          ? matchedElement.rect
          : { x: 0, y: 0, w: 0, h: 0 };

      const finalElement = resolved
        ? {
            tag: resolved.tag,
            text: resolved.text,
            selectorTypes: resolved.selectorTypes,
            rect: finalRect,
          }
        : matchedElement || {
            tag: (snippet.match(/<(\w+)/) || ["", "?"])[1].toLowerCase(),
            text: "",
            selectorTypes: [],
            rect: finalRect,
          };

      const wcagTags = rule.tags || [];
      violations.push({
        source: "axe-core",
        ruleId: rule.id,
        description: rule.help || rule.description,
        impact: rule.impact || "moderate",
        helpUrl: dequeLink,
        wcagTags: wcagTags,
        wcagLevel: getWcagLevel(wcagTags),
        selector: selector,
        htmlSnippet: snippet,
        element: finalElement,
        rect: finalRect,
      });
    });
  });

  // 4b — Process custom rule issues
  customIssues.forEach((issue) => {
    // Skip if axe already flagged same element for similar rule
    const isDuplicate = violations.some((v) => {
      if (!v.element || !issue.element) return false;
      const sameElement =
        v.element.tag === issue.element.tag &&
        v.element.rect.x === issue.element.rect.x &&
        v.element.rect.y === issue.element.rect.y;
      // Similar rule mapping
      const ruleMap = {
        "custom-img-alt-missing": "image-alt",
        "custom-link-name": "link-name",
        "custom-button-name": "button-name",
        "custom-input-label": "label",
        "custom-form-field-label": "label",
        "custom-empty-heading": "empty-heading",
        "custom-heading-order": "heading-order",
        "custom-html-lang": "html-has-lang",
      };
      const axeEquivalent = ruleMap[issue.ruleId];
      return sameElement && axeEquivalent && v.ruleId === axeEquivalent;
    });

    if (!isDuplicate) {
      violations.push({
        source: "custom",
        ruleId: issue.ruleId,
        description: issue.description,
        impact: issue.impact,
        helpUrl: issue.helpUrl,
        wcagTags: issue.wcagTags,
        wcagLevel: issue.wcagLevel || getWcagLevel(issue.wcagTags),
        selector: issue.element.selector || "",
        htmlSnippet: issue.element.htmlSnippet || "",
        element: issue.element,
        rect: issue.element.rect,
      });
    }
  });

  // Sort by severity then by page position (top to bottom)
  violations.sort((a, b) => {
    const impactDiff = (IMPACT_ORDER[a.impact] ?? 9) - (IMPACT_ORDER[b.impact] ?? 9);
    if (impactDiff !== 0) return impactDiff;
    return (a.rect.y || 0) - (b.rect.y || 0);
  });

  console.log(`    Total merged violations: ${violations.length}`);

  //  Step 5: Screenshot 
  console.log("   Capturing full-page screenshot…");
  const base = `report-${timestamp()}`;
  const screenshotPath = path.join(REPORT_DIR, `${base}-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const screenshotBase64 = fs.readFileSync(screenshotPath).toString('base64');
  const screenshotDataUri = `data:image/png;base64,${screenshotBase64}`;
  await browser.close();

  //  Step 6: Build stats 
  const stats = {
    total: violations.length,
    critical: violations.filter((v) => v.impact === "critical").length,
    serious: violations.filter((v) => v.impact === "serious").length,
    moderate: violations.filter((v) => v.impact === "moderate").length,
    minor: violations.filter((v) => v.impact === "minor").length,
    levelA: violations.filter((v) => v.wcagLevel === "A").length,
    levelAA: violations.filter((v) => v.wcagLevel === "AA").length,
    levelAAA: violations.filter((v) => v.wcagLevel === "AAA").length,
    axeCount: violations.filter((v) => v.source === "axe-core").length,
    customCount: violations.filter((v) => v.source === "custom").length,
  };

  const totalRules =
    (axeResults.passes ? axeResults.passes.length : 0) + axeResults.violations.length;
  const score =
    totalRules === 0
      ? 100
      : Math.max(0, 100 - (axeResults.violations.length / totalRules) * 100).toFixed(1);

  //  Step 7: Generate HTML report 
  console.log("  ▸ Generating report…");

  //  AI Quick Fix Suggestions
  const getQuickFix = (v) => {
    const tag = v.element.tag || "?";
    const text = (v.element.text || "").substring(0, 30);
    const snippet = (v.htmlSnippet || "").substring(0, 100);
    const id = v.ruleId;

    // Axe-core rules
    const fixes = {
      "image-alt": () => {
        if (snippet.includes("role=\"presentation\"") || snippet.includes("role=\"none\""))
          return "Decorative image — add alt=\"\" (empty alt).";
        return `Add a descriptive alt attribute: &lt;img alt="describe what this image shows"&gt;`;
      },
      "link-name": () => {
        if (snippet.includes("<img"))
          return "Image-only link — add alt text to the inner &lt;img&gt; or add aria-label to the &lt;a&gt;.";
        return `Add text content or aria-label to this link: &lt;a aria-label="describe destination"&gt;`;
      },
      "button-name": () =>
        `Add text or aria-label: &lt;button aria-label="describe action"&gt;`,
      "label": () =>
        `Add a &lt;label for="inputId"&gt; or aria-label attribute to the form field.`,
      "color-contrast": () =>
        "Increase text/background contrast ratio. Use a tool like contrast-ratio.com to find valid colors.",
      "empty-heading": () =>
        `Add text content inside the &lt;${tag}&gt; tag — empty headings confuse screen readers.`,
      "heading-order": () =>
        "Fix heading hierarchy — don't skip levels (e.g., go h1 → h2, not h1 → h3).",
      "html-has-lang": () =>
        `Add lang attribute: &lt;html lang="en"&gt;`,
      "region": () =>
        "Wrap page content in landmark elements: &lt;main&gt;, &lt;nav&gt;, &lt;header&gt;, &lt;footer&gt;.",
      "landmark-one-main": () =>
        "Add a &lt;main&gt; element to wrap the primary content of the page.",
      "page-has-heading-one": () =>
        "Add an &lt;h1&gt; heading that describes the page content.",
      "meta-viewport": () =>
        'Don\'t use maximum-scale=1 or user-scalable=no in &lt;meta name="viewport"&gt;.',
      "aria-allowed-attr": () =>
        "Remove the invalid ARIA attribute — check allowed attributes for this role.",
      "aria-required-attr": () =>
        "Add the required ARIA attribute for this element's role.",
      "aria-valid-attr-value": () =>
        "Fix the ARIA attribute value — it must match the expected format.",
      "aria-hidden-focus": () =>
        'Remove aria-hidden="true" from this focusable element, or add tabindex="-1".',
      "tabindex": () =>
        "Remove positive tabindex. Use tabindex=\"0\" for focusable or tabindex=\"-1\" for programmatic focus.",
      "list": () =>
        "Ensure &lt;ul&gt;/&lt;ol&gt; only contains &lt;li&gt; children.",
      "listitem": () =>
        "Wrap &lt;li&gt; inside a &lt;ul&gt; or &lt;ol&gt; parent.",
      "definition-list": () =>
        "Ensure &lt;dl&gt; only contains &lt;dt&gt; and &lt;dd&gt; groups.",
      "duplicate-id": () =>
        "Each id must be unique — rename duplicate ids on the page.",
      "frame-title": () =>
        `Add a title attribute: &lt;iframe title="describe iframe content"&gt;`,
      "document-title": () =>
        "Add a &lt;title&gt; in the &lt;head&gt; that describes the page.",
      "td-headers-attr": () =>
        "Fix the headers attribute to reference valid &lt;th&gt; id values.",
    };

    // Custom rules
    const customFixes = {
      "custom-img-alt-missing": () =>
        `Add alt attribute: &lt;img alt="describe the image content"&gt;`,
      "custom-img-alt-quality": () =>
        `Replace generic alt text with a meaningful description of what the image shows.`,
      "custom-img-alt-short": () =>
        `Make alt text more descriptive — at least a short phrase explaining the image.`,
      "custom-link-name": () =>
        `Add text or aria-label: &lt;a aria-label="describe where this goes"&gt;`,
      "custom-button-name": () =>
        `Add label: &lt;button aria-label="describe the action"&gt;`,
      "custom-input-label": () =>
        `Add &lt;label for="id"&gt;Label&lt;/label&gt; or aria-label to this input.`,
      "custom-form-field-label": () =>
        `Add &lt;label for="id"&gt;Label&lt;/label&gt; or aria-label to this &lt;${tag}&gt;.`,
      "custom-empty-heading": () =>
        `Add text content inside &lt;${tag}&gt; — don't leave headings empty.`,
      "custom-heading-order": () =>
        "Fix heading order — use sequential levels without skipping.",
      "custom-html-lang": () =>
        `Add: &lt;html lang="en"&gt; (use your page's language code).`,
      "custom-tabindex-positive": () =>
        "Change to tabindex=\"0\" or remove it — positive tabindex breaks tab order.",
      "custom-interactive-not-focusable": () =>
        `Add tabindex="0" to make this &lt;${tag}&gt; keyboard accessible.`,
    };

    const fixFn = fixes[id] || customFixes[id];
    if (fixFn) return fixFn();

    // Fallback based on element type
    if (tag === "img") return "Add a meaningful alt attribute to this image.";
    if (tag === "a") return "Add descriptive text or aria-label to this link.";
    if (tag === "button") return "Add a label or aria-label to this button.";
    if (tag === "input") return "Associate a label with this input field.";
    return "Review this element for accessibility compliance.";
  };

  const impactBadge = (impact) => {
    const colors = {
      critical: "#ef4444",
      serious: "#f97316",
      moderate: "#eab308",
      minor: "#3b82f6",
    };
    return `<span class="badge" style="background:${colors[impact] || "#6b7280"}">${impact}</span>`;
  };

  const sourceBadge = (source) => {
    return source === "axe-core"
      ? '<span class="badge badge-source" style="background:#6366f1">axe-core</span>'
      : '<span class="badge badge-source" style="background:#10b981">custom</span>';
  };

  const wcagLevelBadge = (level) => {
    const colors = { A: "#059669", AA: "#0891b2", AAA: "#7c3aed" };
    return `<span class="badge" style="background:${colors[level] || '#6b7280'}">Level ${level}</span>`;
  };

  const tableRows = violations
    .map(
      (v, i) => `
      <tr data-index="${i}" data-impact="${v.impact}" data-wcag-level="${v.wcagLevel}">
        <td class="sr-link" title="Click to highlight on screenshot">${i + 1}</td>
        <td><code>&lt;${v.element.tag}&gt;</code></td>
        <td class="snippet-cell">${v.element.text ? v.element.text.substring(0, 60) : '<span class="empty">empty</span>'}</td>
        <td>${(v.element.selectorTypes || []).join(", ") || "—"}</td>
        <td>${v.description}</td>
        <td>${impactBadge(v.impact)}</td>
        <td>${wcagLevelBadge(v.wcagLevel)}</td>
        <td>${sourceBadge(v.source)}</td>
        <td class="fix-cell">💡 ${getQuickFix(v)}</td>
        <td><a href="${v.helpUrl}" target="_blank" rel="noopener noreferrer" class="fix-link" title="Learn how to fix: ${v.ruleId}">🔗 ${v.ruleId}</a></td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Accessibility Report — ${url}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    line-height: 1.6;
  }

  /*  Header  */
  .hero {
    background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%);
    padding: 48px 32px 36px;
    text-align: center;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .hero h1 {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.5px;
    color: #fff;
    margin-bottom: 6px;
  }
  .hero .url {
    font-size: 14px;
    color: #a5b4fc;
    word-break: break-all;
    font-weight: 500;
  }
  .hero .meta {
    margin-top: 8px;
    font-size: 12px;
    color: #818cf8;
  }

  /*  Stats bar  */
  .stats-bar {
    display: flex;
    justify-content: center;
    gap: 16px;
    flex-wrap: wrap;
    padding: 24px 32px;
    background: #1e293b;
    border-bottom: 1px solid #334155;
  }
  .stat-card {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 16px 28px;
    text-align: center;
    min-width: 120px;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .stat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
  .stat-card .num {
    font-size: 32px;
    font-weight: 800;
    line-height: 1;
  }
  .stat-card .lbl {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-top: 6px;
    color: #94a3b8;
    font-weight: 600;
  }
  .stat-card.critical .num { color: #ef4444; }
  .stat-card.serious .num  { color: #f97316; }
  .stat-card.moderate .num { color: #eab308; }
  .stat-card.minor .num    { color: #3b82f6; }
  .stat-card.score .num    { color: #22c55e; }
  .stat-card.total .num    { color: #e2e8f0; }

  /*  Container */
  .container {
    max-width: 1440px;
    margin: 0 auto;
    padding: 32px;
  }

  /*  Section titles  */
  .section-title {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 16px;
    color: #f1f5f9;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section-title::before {
    content: '';
    width: 4px;
    height: 24px;
    background: #6366f1;
    border-radius: 2px;
  }

  /*  Screenshot area  */
  #visualArea {
    position: relative;
    width: 100%;
    border: 1px solid #334155;
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: 40px;
    background: #1e293b;
  }
  #pageImage {
    width: 100%;
    display: block;
  }
  #overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
  }
  .highlight-box {
    position: absolute;
    border: 3px solid #ef4444;
    background: rgba(239, 68, 68, 0.2);
    border-radius: 4px;
    z-index: 1000;
    animation: pulse-border 1.5s ease-in-out infinite;
  }
  @keyframes pulse-border {
    0%, 100% { border-color: #ef4444; box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
    50%      { border-color: #fbbf24; box-shadow: 0 0 12px 4px rgba(239,68,68,0.2); }
  }

  /*  Filters  */
  .filters {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .filter-btn {
    padding: 6px 16px;
    border-radius: 20px;
    border: 1px solid #475569;
    background: transparent;
    color: #cbd5e1;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  .filter-btn:hover { background: #334155; }
  .filter-btn.active {
    background: #6366f1;
    border-color: #6366f1;
    color: #fff;
  }

  /*  Table  */
  .table-wrap {
    overflow-x: auto;
    border-radius: 12px;
    border: 1px solid #334155;
    background: #1e293b;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    background: #334155;
    color: #e2e8f0;
    padding: 14px 16px;
    text-align: left;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    position: sticky;
    top: 0;
    z-index: 10;
    white-space: nowrap;
  }
  td {
    padding: 12px 16px;
    border-top: 1px solid #1e293b;
    vertical-align: top;
    color: #cbd5e1;
  }
  tr:hover { background: rgba(99, 102, 241, 0.08); }
  tr.active { background: rgba(250,204,21,0.1) !important; outline: 2px solid #fbbf24; outline-offset: -2px; }

  .sr-link {
    font-weight: 700;
    color: #818cf8;
    cursor: pointer;
    user-select: none;
    text-align: center;
    min-width: 36px;
  }
  .sr-link:hover { color: #a5b4fc; text-decoration: underline; }

  code {
    background: #0f172a;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    color: #c084fc;
  }

  .empty { color: #64748b; font-style: italic; }

  .snippet-cell {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /*  Badges */
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #fff;
    white-space: nowrap;
  }
  .badge-source { font-size: 10px; padding: 2px 8px; }

  .fix-link {
    color: #818cf8;
    text-decoration: none;
    font-weight: 600;
    font-size: 12px;
    white-space: nowrap;
    transition: color 0.2s;
  }
  .fix-link:hover { color: #a5b4fc; text-decoration: underline; }

  .fix-cell {
    font-size: 12px;
    color: #86efac;
    max-width: 280px;
    line-height: 1.5;
  }

  /*  Footer */
  .footer {
    text-align: center;
    padding: 32px;
    font-size: 12px;
    color: #475569;
    border-top: 1px solid #1e293b;
    margin-top: 48px;
  }

  /*  Responsive  */
  @media (max-width: 768px) {
    .hero h1 { font-size: 20px; }
    .stats-bar { gap: 8px; padding: 16px; }
    .stat-card { padding: 12px 16px; min-width: 90px; }
    .stat-card .num { font-size: 24px; }
    .container { padding: 16px; }
    th, td { padding: 8px 10px; font-size: 11px; }
    .download-toolbar { flex-direction: column; align-items: stretch; }
  }

  /*  Download Toolbar  */
  .download-toolbar {
    display: flex;
    justify-content: center;
    gap: 12px;
    margin-top: 20px;
    flex-wrap: wrap;
  }
  .download-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 24px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.08);
    backdrop-filter: blur(10px);
    color: #e2e8f0;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.25s ease;
    text-decoration: none;
  }
  .download-btn:hover {
    background: rgba(255,255,255,0.15);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0,0,0,0.3);
  }
  .download-btn .icon { font-size: 16px; }
  .download-btn.pdf { border-color: #f87171; }
  .download-btn.pdf:hover { background: rgba(239,68,68,0.2); }
  .download-btn.json { border-color: #34d399; }
  .download-btn.json:hover { background: rgba(16,185,129,0.2); }
  .download-btn.html-dl { border-color: #60a5fa; }
  .download-btn.html-dl:hover { background: rgba(96,165,250,0.2); }

  /*  Filter Groups  */
  .filter-group {
    margin-bottom: 12px;
  }
  .filter-group-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #64748b;
    margin-bottom: 8px;
  }
  .filter-btn.wcag-level.active {
    background: #059669;
    border-color: #059669;
    color: #fff;
  }

  /*  Print Styles  */
  @media print {
    body { background: #fff !important; color: #1e293b !important; }
    .hero { background: #f8fafc !important; border-bottom: 2px solid #e2e8f0; }
    .hero h1 { color: #1e293b !important; }
    .hero .url { color: #475569 !important; }
    .hero .meta { color: #64748b !important; }
    .download-toolbar { display: none !important; }
    .stats-bar { background: #f1f5f9 !important; }
    .stat-card { background: #fff !important; border-color: #e2e8f0 !important; }
    .stat-card .num { color: #1e293b !important; }
    .stat-card .lbl { color: #475569 !important; }
    .stat-card.critical .num { color: #dc2626 !important; }
    .stat-card.serious .num { color: #ea580c !important; }
    .stat-card.moderate .num { color: #ca8a04 !important; }
    .stat-card.minor .num { color: #2563eb !important; }
    .stat-card.score .num { color: #16a34a !important; }
    .container { max-width: 100%; padding: 16px; }
    #visualArea { display: none !important; }
    .section-title { color: #1e293b !important; }
    .section-title::before { background: #6366f1 !important; }
    .filters, .filter-group { display: none !important; }
    .table-wrap { border-color: #e2e8f0 !important; background: #fff !important; }
    th { background: #f1f5f9 !important; color: #1e293b !important; }
    td { color: #334155 !important; border-top-color: #e2e8f0 !important; }
    tr:hover { background: transparent !important; }
    code { background: #f1f5f9 !important; color: #7c3aed !important; }
    .fix-cell { color: #059669 !important; }
    .fix-link { color: #4f46e5 !important; }
    .footer { color: #94a3b8 !important; border-top-color: #e2e8f0 !important; }
    .badge { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  }
</style>
</head>
<body>

<!-- Header -->
<div class="hero">
  <h1> Accessibility Audit Report</h1>
  <div class="url">${url}</div>
  <div class="meta">Generated on ${new Date().toLocaleString()} • Powered by axe-core + Custom WCAG Rules</div>
  <div class="download-toolbar">
    <button class="download-btn pdf" id="downloadPdf" title="Export as PDF via Print">
      <span class="icon"></span> Download PDF
    </button>
    <button class="download-btn json" id="downloadJson" title="Download raw JSON data">
      <span class="icon"></span> Download JSON
    </button>
    <button class="download-btn html-dl" id="downloadHtml" title="Download this HTML report">
      <span class="icon"></span> Download HTML
    </button>
  </div>
</div>

<!-- Stats -->
<div class="stats-bar">
  <div class="stat-card score">
    <div class="num">${score}%</div>
    <div class="lbl">Score</div>
  </div>
  <div class="stat-card total">
    <div class="num">${stats.total}</div>
    <div class="lbl">Violations</div>
  </div>
  <div class="stat-card critical">
    <div class="num">${stats.critical}</div>
    <div class="lbl">Critical</div>
  </div>
  <div class="stat-card serious">
    <div class="num">${stats.serious}</div>
    <div class="lbl">Serious</div>
  </div>
  <div class="stat-card moderate">
    <div class="num">${stats.moderate}</div>
    <div class="lbl">Moderate</div>
  </div>
  <div class="stat-card minor">
    <div class="num">${stats.minor}</div>
    <div class="lbl">Minor</div>
  </div>
</div>

<div class="container">

  <!-- Screenshot -->
  <div class="section-title">Page Screenshot</div>
  <div id="visualArea">
    <img id="pageImage" src="${screenshotDataUri}" alt="Full page screenshot">
    <div id="overlay"></div>
  </div>

  <!-- Violations Table -->
  <div class="section-title">Violations Found (${stats.total})</div>

  <div class="filter-group">
    <div class="filter-group-label"> Severity</div>
    <div class="filters" id="severityFilters">
      <button class="filter-btn active" data-filter="all">All (${stats.total})</button>
      <button class="filter-btn" data-filter="critical">Critical (${stats.critical})</button>
      <button class="filter-btn" data-filter="serious">Serious (${stats.serious})</button>
      <button class="filter-btn" data-filter="moderate">Moderate (${stats.moderate})</button>
      <button class="filter-btn" data-filter="minor">Minor (${stats.minor})</button>
    </div>
  </div>

  <div class="filter-group">
    <div class="filter-group-label"> WCAG Conformance Level</div>
    <div class="filters" id="wcagFilters">
      <button class="filter-btn wcag-level active" data-filter-level="all">All Levels (${stats.total})</button>
      <button class="filter-btn wcag-level" data-filter-level="A">Level A (${stats.levelA})</button>
      <button class="filter-btn wcag-level" data-filter-level="AA">Level AA (${stats.levelAA})</button>
      <button class="filter-btn wcag-level" data-filter-level="AAA">Level AAA (${stats.levelAAA})</button>
    </div>
  </div>

  <div class="table-wrap">
    <table id="violationsTable">
      <thead>
        <tr>
          <th>#</th>
          <th>Element</th>
          <th>Content</th>
          <th>Selectors</th>
          <th>Violation</th>
          <th>Severity</th>
          <th>WCAG Level</th>
          <th>Source</th>
          <th> AI Fix</th>
          <th>Learn More</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>

</div>

<div class="footer">
  Web Accessibility Inspector • axe-core results: ${stats.axeCount} • Custom rule results: ${stats.customCount}
</div>

<script>
// ── Violations data (for highlight positions + downloads) ──
const violations = ${JSON.stringify(violations.map((v) => ({ rect: v.rect })))};
const fullViolations = ${JSON.stringify(violations.map((v) => ({ source: v.source, ruleId: v.ruleId, description: v.description, impact: v.impact, wcagLevel: v.wcagLevel, wcagTags: v.wcagTags, helpUrl: v.helpUrl, selector: v.selector, htmlSnippet: v.htmlSnippet, element: { tag: v.element.tag, text: v.element.text, rect: v.element.rect } })))};
const overlay = document.getElementById('overlay');
const img = document.getElementById('pageImage');
let currentBox = null;
let currentLabel = null;

function getScale() {
  if (!img.naturalWidth) return 1;
  return img.clientWidth / img.naturalWidth;
}

function clearHighlight() {
  if (currentBox) { currentBox.remove(); currentBox = null; }
  if (currentLabel) { currentLabel.remove(); currentLabel = null; }
  document.querySelectorAll('tr.active').forEach(r => r.classList.remove('active'));
}

function highlightElement(row) {
  const idx = parseInt(row.dataset.index);
  const v = violations[idx];
  if (!v || !v.rect) return;

  clearHighlight();
  row.classList.add('active');

  const scale = getScale();
  const visualArea = document.getElementById('visualArea');

  if (v.rect.w > 0 && v.rect.h > 0) {
    const box = document.createElement('div');
    box.className = 'highlight-box';
    box.style.left   = (v.rect.x * scale) + 'px';
    box.style.top    = (v.rect.y * scale) + 'px';
    box.style.width  = (v.rect.w * scale) + 'px';
    box.style.height = (v.rect.h * scale) + 'px';
    overlay.appendChild(box);
    currentBox = box;

    const label = document.createElement('div');
    label.textContent = '#' + (idx + 1);
    label.style.cssText = 'position:absolute;background:#ef4444;color:#fff;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;z-index:1001;pointer-events:none;font-family:Inter,sans-serif;';
    label.style.left = (v.rect.x * scale) + 'px';
    label.style.top  = Math.max(0, (v.rect.y * scale) - 20) + 'px';
    overlay.appendChild(label);
    currentLabel = label;

    const highlightTop = visualArea.offsetTop + (v.rect.y * scale);
    window.scrollTo({ top: highlightTop - 150, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: visualArea.offsetTop - 50, behavior: 'smooth' });
  }
}

function attachEvents() {
  document.querySelectorAll('tbody tr').forEach(row => {
    const srCell = row.querySelector('.sr-link');
    if (!srCell) return;
    srCell.addEventListener('click', () => highlightElement(row));
  });
}

if (img.complete) {
  attachEvents();
} else {
  img.addEventListener('load', attachEvents);
}

//  Cross-filter logic (severity × WCAG level) 
let activeSeverity = 'all';
let activeWcagLevel = 'all';

function applyFilters() {
  document.querySelectorAll('tbody tr').forEach(row => {
    const matchSeverity = (activeSeverity === 'all' || row.dataset.impact === activeSeverity);
    const matchLevel = (activeWcagLevel === 'all' || row.dataset.wcagLevel === activeWcagLevel);
    row.style.display = (matchSeverity && matchLevel) ? '' : 'none';
  });
}

// Severity filter buttons
document.querySelectorAll('#severityFilters .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#severityFilters .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeSeverity = btn.dataset.filter;
    applyFilters();
  });
});

// WCAG level filter buttons
document.querySelectorAll('#wcagFilters .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#wcagFilters .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeWcagLevel = btn.dataset.filterLevel;
    applyFilters();
  });
});

//  Download handlers 
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

// PDF — use browser print dialog
document.getElementById('downloadPdf').addEventListener('click', () => {
  window.print();
});

// JSON download
document.getElementById('downloadJson').addEventListener('click', () => {
  const jsonStr = JSON.stringify(fullViolations, null, 2);
  downloadFile(jsonStr, 'accessibility-report.json', 'application/json');
});

// HTML download
document.getElementById('downloadHtml').addEventListener('click', () => {
  const htmlContent = '<!DOCTYPE html>' + document.documentElement.outerHTML;
  downloadFile(htmlContent, 'accessibility-report.html', 'text/html');
});
</script>
</body>
</html>`;

  //  Save files 
  const jsonPath = path.join(REPORT_DIR, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(violations, null, 2));

  const htmlPath = path.join(REPORT_DIR, `${base}.html`);
  fs.writeFileSync(htmlPath, html);

  console.log(`\n Report generated: ${htmlPath}`);
  console.log(`   Screenshot: ${screenshotPath}`);
  console.log(`   JSON data:  ${jsonPath}\n`);

  // Open in default browser (Windows)
  const { exec } = require("child_process");
  exec(`explorer "${htmlPath}"`);
})();