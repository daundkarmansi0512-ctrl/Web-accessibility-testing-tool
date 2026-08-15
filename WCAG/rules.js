/**
 * Enhanced WCAG Custom Rules
 * These rules complement axe-core by catching issues it misses or
 * providing additional context (element positions, richer descriptions).
 *
 * Each issue object:
 *   ruleId        – unique identifier
 *   description   – human-readable explanation
 *   impact        – "critical" | "serious" | "moderate" | "minor"
 *   helpUrl       – Deque University reference
 *   wcagTags      – related WCAG criteria
 *   wcagLevel     – "A" | "AA" | "AAA"
 *   wcagPrinciple – "Perceivable" | "Operable" | "Understandable" | "Robust"
 */

// ─── Color contrast utilities (WCAG 2.1 algorithm) ───
function parseColor(colorStr) {
  if (!colorStr || colorStr === "transparent" || colorStr === "rgba(0, 0, 0, 0)") return null;
  const rgba = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!rgba) return null;
  return {
    r: parseInt(rgba[1]),
    g: parseInt(rgba[2]),
    b: parseInt(rgba[3]),
    a: rgba[4] !== undefined ? parseFloat(rgba[4]) : 1,
  };
}

function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(color1, color2) {
  const l1 = relativeLuminance(color1.r, color1.g, color1.b);
  const l2 = relativeLuminance(color2.r, color2.g, color2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isLargeText(fontSize, fontWeight) {
  const size = parseFloat(fontSize) || 16;
  const weight = parseInt(fontWeight) || 400;
  // Large text: >= 18pt (24px) or >= 14pt (18.66px) and bold (>=700)
  return size >= 24 || (size >= 18.66 && weight >= 700);
}

// ─── Main compliance checker ───
function checkWCAGCompliance(elements) {
  const issues = []; // flat list — one entry per element+rule violation

  // Build a heading-order array for hierarchy check
  const headings = elements
    .filter((el) => /^h[1-6]$/.test(el.tag))
    .sort((a, b) => {
      if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
      return a.rect.x - b.rect.x;
    });

  elements.forEach((el, idx) => {
    // ──────────────────────────────────────────────
    // Rule 1: Images must have MEANINGFUL alt text
    // ──────────────────────────────────────────────
    if (el.tag === "img") {
      const alt = (el.alt || "").trim();
      if (!alt) {
        issues.push({
          elementIndex: idx,
          element: el,
          ruleId: "custom-img-alt-missing",
          description: "Image is missing the alt attribute entirely.",
          impact: "critical",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.11/image-alt",
          wcagTags: ["wcag111", "wcag2a"],
          wcagLevel: "A",
          wcagPrinciple: "Perceivable",
        });
      } else {
        const lower = alt.toLowerCase();
        const generic = ["image", "photo", "picture", "img", "icon", "graphic", "banner", "logo image", "untitled"];
        if (generic.some((w) => lower === w || lower === w + ".png" || lower === w + ".jpg" || lower === w + ".jpeg")) {
          issues.push({
            elementIndex: idx,
            element: el,
            ruleId: "custom-img-alt-quality",
            description: `Alt text is generic/unhelpful: "${alt}"`,
            impact: "moderate",
            helpUrl: "https://dequeuniversity.com/rules/axe/4.11/image-alt",
            wcagTags: ["wcag111", "wcag2a"],
            wcagLevel: "A",
            wcagPrinciple: "Perceivable",
          });
        }
        if (alt.length < 3 && !el.role) {
          issues.push({
            elementIndex: idx,
            element: el,
            ruleId: "custom-img-alt-short",
            description: `Alt text is suspiciously short (${alt.length} chars): "${alt}"`,
            impact: "moderate",
            helpUrl: "https://dequeuniversity.com/rules/axe/4.11/image-alt",
            wcagTags: ["wcag111", "wcag2a"],
            wcagLevel: "A",
            wcagPrinciple: "Perceivable",
          });
        }
      }
    }

    // ──────────────────────────────────────────────
    // Rule 2: Links must have accessible names
    // ──────────────────────────────────────────────
    if (el.tag === "a") {
      const hasText = el.text && el.text.trim().length > 0;
      const hasAriaLabel = el.ariaLabel && el.ariaLabel.trim().length > 0;
      const hasTitle = el.title && el.title.trim().length > 0;
      if (!hasText && !hasAriaLabel && !hasTitle) {
        issues.push({
          elementIndex: idx,
          element: el,
          ruleId: "custom-link-name",
          description: "Link has no accessible name (no text, aria-label, or title).",
          impact: "serious",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.11/link-name",
          wcagTags: ["wcag244", "wcag412", "wcag2a"],
          wcagLevel: "A",
          wcagPrinciple: "Operable",
        });
      }
    }

    // ──────────────────────────────────────────────
    // Rule 3: Buttons must have accessible labels
    // ──────────────────────────────────────────────
    if (el.tag === "button" || (el.role && el.role === "button")) {
      const hasText = el.text && el.text.trim().length > 0;
      const hasAriaLabel = el.ariaLabel && el.ariaLabel.trim().length > 0;
      const hasTitle = el.title && el.title.trim().length > 0;
      if (!hasText && !hasAriaLabel && !hasTitle) {
        issues.push({
          elementIndex: idx,
          element: el,
          ruleId: "custom-button-name",
          description: "Button has no accessible name (no text, aria-label, or title).",
          impact: "serious",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.11/button-name",
          wcagTags: ["wcag412", "wcag2a"],
          wcagLevel: "A",
          wcagPrinciple: "Robust",
        });
      }
    }

    // ──────────────────────────────────────────────
    // Rule 4: Input fields must have labels
    // ──────────────────────────────────────────────
    if (el.tag === "input" && el.type !== "hidden" && el.type !== "submit" && el.type !== "button") {
      const hasId = el.id && el.id.trim().length > 0;
      const hasAriaLabel = el.ariaLabel && el.ariaLabel.trim().length > 0;
      const hasPlaceholder = el.placeholder && el.placeholder.trim().length > 0;
      // If no id (for <label for=>) and no aria-label, likely unlabeled
      if (!hasId && !hasAriaLabel) {
        issues.push({
          elementIndex: idx,
          element: el,
          ruleId: "custom-input-label",
          description: "Input field may be missing an associated label (no id for label-for, no aria-label).",
          impact: "critical",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.11/label",
          wcagTags: ["wcag111", "wcag131", "wcag2a"],
          wcagLevel: "A",
          wcagPrinciple: "Perceivable",
        });
      } else if (!hasAriaLabel && !hasPlaceholder && hasId) {
        // Has id but we can't verify server-side if a <label for="id"> exists
        // Flag as minor informational
      }
    }

    // ──────────────────────────────────────────────
    // Rule 5: Select and textarea also need labels
    // ──────────────────────────────────────────────
    if (el.tag === "select" || el.tag === "textarea") {
      const hasId = el.id && el.id.trim().length > 0;
      const hasAriaLabel = el.ariaLabel && el.ariaLabel.trim().length > 0;
      if (!hasId && !hasAriaLabel) {
        issues.push({
          elementIndex: idx,
          element: el,
          ruleId: "custom-form-field-label",
          description: `<${el.tag}> is missing an associated label (no id, no aria-label).`,
          impact: "critical",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.11/label",
          wcagTags: ["wcag111", "wcag131", "wcag2a"],
          wcagLevel: "A",
          wcagPrinciple: "Perceivable",
        });
      }
    }

    // ──────────────────────────────────────────────
    // Rule 6: Empty headings
    // ──────────────────────────────────────────────
    if (/^h[1-6]$/.test(el.tag)) {
      if (!el.text || el.text.trim().length === 0) {
        issues.push({
          elementIndex: idx,
          element: el,
          ruleId: "custom-empty-heading",
          description: `<${el.tag}> heading is empty — provides no information to screen readers.`,
          impact: "moderate",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.11/empty-heading",
          wcagTags: ["wcag131", "wcag2a"],
          wcagLevel: "A",
          wcagPrinciple: "Perceivable",
        });
      }
    }

    // ──────────────────────────────────────────────
    // Rule 7: Tabindex > 0 is an anti-pattern
    // ──────────────────────────────────────────────
    if (el.tabindex !== undefined && el.tabindex !== null && Number(el.tabindex) > 0) {
      issues.push({
        elementIndex: idx,
        element: el,
        ruleId: "custom-tabindex-positive",
        description: `Element has tabindex="${el.tabindex}" — positive tabindex disrupts natural tab order.`,
        impact: "moderate",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.11/tabindex",
        wcagTags: ["wcag241", "wcag2a"],
        wcagLevel: "A",
        wcagPrinciple: "Operable",
      });
    }

    // ──────────────────────────────────────────────
    // Rule 8: Interactive elements must be focusable
    // ──────────────────────────────────────────────
    if (el.role === "button" || el.role === "link" || el.role === "tab") {
      const interactive = ["a", "button", "input", "select", "textarea"];
      if (!interactive.includes(el.tag) && (el.tabindex === undefined || el.tabindex === null)) {
        issues.push({
          elementIndex: idx,
          element: el,
          ruleId: "custom-interactive-not-focusable",
          description: `Element has role="${el.role}" but is a <${el.tag}> without tabindex — may not be keyboard accessible.`,
          impact: "serious",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.11/focus-order-semantics",
          wcagTags: ["wcag211", "wcag2a"],
          wcagLevel: "A",
          wcagPrinciple: "Operable",
        });
      }
    }

    // ──────────────────────────────────────────────
    // Rule 11: Color contrast check (WCAG 1.4.3)
    // ──────────────────────────────────────────────
    if (el.computedColor && el.computedBgColor) {
      const textTags = ["p", "span", "a", "li", "td", "th", "label", "div", "h1", "h2", "h3", "h4", "h5", "h6", "button", "strong", "em", "b", "i", "small", "code", "pre"];
      if (textTags.includes(el.tag) && el.text && el.text.trim().length > 0) {
        const fg = parseColor(el.computedColor);
        const bg = parseColor(el.computedBgColor);
        if (fg && bg && fg.a > 0.1 && bg.a > 0.1) {
          const ratio = contrastRatio(fg, bg);
          const large = isLargeText(el.fontSize, el.fontWeight);
          const requiredAA = large ? 3.0 : 4.5;
          const requiredAAA = large ? 4.5 : 7.0;

          if (ratio < requiredAA) {
            issues.push({
              elementIndex: idx,
              element: el,
              ruleId: "custom-color-contrast",
              description: `Insufficient contrast ratio ${ratio.toFixed(2)}:1 (requires ${requiredAA}:1 for ${large ? "large" : "normal"} text). Colors: text ${el.computedColor} on ${el.computedBgColor}.`,
              impact: "serious",
              helpUrl: "https://dequeuniversity.com/rules/axe/4.11/color-contrast",
              wcagTags: ["wcag143", "wcag2aa"],
              wcagLevel: "AA",
              wcagPrinciple: "Perceivable",
              contrastRatio: ratio.toFixed(2),
            });
          } else if (ratio < requiredAAA) {
            issues.push({
              elementIndex: idx,
              element: el,
              ruleId: "custom-color-contrast-enhanced",
              description: `Contrast ratio ${ratio.toFixed(2)}:1 passes AA but fails AAA enhanced (requires ${requiredAAA}:1 for ${large ? "large" : "normal"} text).`,
              impact: "minor",
              helpUrl: "https://dequeuniversity.com/rules/axe/4.11/color-contrast-enhanced",
              wcagTags: ["wcag146", "wcag2aaa"],
              wcagLevel: "AAA",
              wcagPrinciple: "Perceivable",
              contrastRatio: ratio.toFixed(2),
            });
          }
        }
      }
    }
  });

  // ──────────────────────────────────────────────
  // Rule 9: Heading hierarchy (page-level check)
  // ──────────────────────────────────────────────
  for (let i = 1; i < headings.length; i++) {
    const prevLevel = parseInt(headings[i - 1].tag.charAt(1));
    const currLevel = parseInt(headings[i].tag.charAt(1));
    if (currLevel > prevLevel + 1) {
      const el = headings[i];
      const idx = elements.indexOf(el);
      issues.push({
        elementIndex: idx,
        element: el,
        ruleId: "custom-heading-order",
        description: `Heading level skipped: <h${prevLevel}> → <h${currLevel}>. Expected <h${prevLevel + 1}> or same/lower.`,
        impact: "moderate",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.11/heading-order",
        wcagTags: ["wcag131", "wcag2a"],
        wcagLevel: "A",
        wcagPrinciple: "Perceivable",
      });
    }
  }

  // ──────────────────────────────────────────────
  // Rule 10: Missing lang attribute (page-level)
  // ──────────────────────────────────────────────
  const htmlEl = elements.find((el) => el.tag === "html");
  if (htmlEl && (!htmlEl.lang || htmlEl.lang.trim().length === 0)) {
    const idx = elements.indexOf(htmlEl);
    issues.push({
      elementIndex: idx,
      element: htmlEl,
      ruleId: "custom-html-lang",
      description: '<html> element is missing the lang attribute — screen readers cannot determine page language.',
      impact: "serious",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.10/html-has-lang",
      wcagTags: ["wcag311", "wcag2a"],
      wcagLevel: "A",
      wcagPrinciple: "Understandable",
    });
  }

  return issues;
}

module.exports = { checkWCAGCompliance };