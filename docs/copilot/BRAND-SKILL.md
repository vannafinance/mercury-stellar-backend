---
name: vanna-brand-guidelines
description: Ensures all UI components, styling, and design elements for Vanna Finance follow the established brand guidelines. Use when creating, modifying, or reviewing any frontend code, components, or design elements.
version: 1.0
category: design-system
---

# Vanna Finance - Brand Guidelines Skill

## Overview
This skill ensures all UI components, styling, and design elements for Vanna Finance follow the established brand guidelines. Use this skill when creating, modifying, or reviewing any frontend code, components, or design elements.

---

## Typography

### Font Family
**Primary Font**: Plus Jakarta Sans
```css
font-family: var(--font-plus-jakarta-sans), system-ui, sans-serif;
```

### Type Scale

#### Headings (Semibold - 600)
- **H1**: 80px / 96px line-height
- **H2**: 64px / 87px line-height  
- **H3**: 48px / 72px line-height
- **H4**: 40px / 60px line-height
- **H5**: 34px / 51px line-height
- **H6**: 28px / 42px line-height
- **H7**: 24px / 36px line-height
- **H8**: 20px / 36px line-height
- **H9**: 16px / 24px line-height
- **H10**: 14px / 21px line-height (Semibold)
- **H11**: 12px / 18px line-height (Semibold)
- **H12**: 10px / 15px line-height (Semibold)

**CSS Classes**: `.text-h1` through `.text-h12`

#### Body Text (Regular - 400)
- **Subtext**: 20px / 30px
- **Body 1**: 16px / 24px
- **Body 2**: 14px / 21px
- **Body 3**: 12px / 18px
- **Body 4**: 10px / 15px
- **Body 5**: 8px / 12px

**CSS Classes**: `.text-subtext`, `.text-body-1` through `.text-body-5`

#### Button Text (Semibold - 600)
- **Large**: 20px / normal
- **Medium**: 16px / normal
- **Small**: 12px / normal

**CSS Classes**: `.text-btn-lg`, `.text-btn-md`, `.text-btn-sm`

### Text Color Themes
```css
.text-heading     /* #1F1F1F - Dark */
.text-paragraph   /* #4B5563 - Gray-600 */
.text-label       /* #1F1F1F - Dark */
.text-placeholder /* #9CA3AF - Gray-400 */
```

---

## Color Palette

### Base Colors
```css
--color-base-dark: #111111
--color-base-white: #FFFFFF
--color-base-platinum: #F7F7F7
```

### Gray Scale
```css
--gray-50:  #F4F4F4
--gray-100: #DFDFDF
--gray-200: #BFBFBF
--gray-300: #A9A9A9
--gray-400: #949494
--gray-500: #777777
--gray-600: #595959
--gray-700: #2C2C2C
--gray-800: #1E1E1E
--gray-900: #111111
```

### Primary Colors - Violet
```css
--violet-50:  #F1EBFD
--violet-100: #D3C2F7
--violet-200: #BDA4F4
--violet-300: #9F7BEE
--violet-400: #8D61EB
--violet-500: #703AE6  /* Primary */
--violet-600: #6635D1
--violet-700: #5029A3
--violet-800: #3E207F
--violet-900: #2F1B61
```

### Primary Colors - Rose
```css
--rose-50:  #FFE6F2
--rose-100: #FFB0D6
--rose-200: #FF8AC2
--rose-300: #FF54A6
--rose-400: #FF3395
--rose-500: #FF007A  /* Primary */
--rose-600: #E8006F
--rose-700: #B50057
--rose-800: #8C0043
--rose-900: #6B0033
```

### Secondary Colors - Imperial Red
```css
--imperial-red-50:  #FEEEEE
--imperial-red-100: #FECACB
--imperial-red-200: #FEB0B2
--imperial-red-300: #FD8C8E
--imperial-red-400: #FD7679
--imperial-red-500: #FC5457  /* Key Secondary */
--imperial-red-600: #E54C4F
--imperial-red-700: #B33C3E
--imperial-red-800: #8B2E30
--imperial-red-900: #6A2325
```

### Secondary Colors - Magenta
```css
--magenta-50:  #EBFCFD
--magenta-100: #BFF6FA
--magenta-200: #A1F2F7
--magenta-300: #76ECF4
--magenta-400: #5BE8F1
--magenta-500: #3E2EE0
--magenta-600: #2E2CD9
--magenta-700: #2440A9
--magenta-800: #1C7C83
--magenta-900: #155F64
```

### Secondary Colors - Electric Blue
```css
--electric-blue-50:  #EBFCFD
--electric-blue-100: #BFF6FA
--electric-blue-200: #A1F2F7
--electric-blue-300: #76ECF4
--electric-blue-400: #5BE8F1
--electric-blue-500: #32EEE2
--electric-blue-600: #22CED9
--electric-blue-700: #24A0A9
--electric-blue-800: #1C7C83
--electric-blue-900: #155F64
```

### Gradient
Primary brand gradient:
```css
.bg-gradient {
  background-image: linear-gradient(135deg, #FC5457 10%, #703AE6 80%);
}
```

### Color Usage Guidelines
**Text Colors:**
- Headings/Titles: `#1F1F1F` (Dark)
- Paragraphs/Descriptions: `#4B5563` (Gray-600)
- Labels: `#1F1F1F` (Dark)
- Placeholders: `#9CA3AF` (Gray-400)

**Background Colors:**
- Table Headers: `#111827` (Gray-900)
- Disabled Inputs, Gray Backgrounds, Stripe Tables: `#F3F4F6` (Gray-100)

**Miscellaneous:**
- Borders: `#E5E7EB` (Gray-200)
- Input Borders: `#D1D5DB` (Gray-300)
- Icons inside Inputs: `#6B7280` (Gray-500)

---

## Spacing System

Base spacing scale (in pixels):
```css
--spacing-0:  2px
--spacing-1:  4px
--spacing-2:  8px
--spacing-3:  12px
--spacing-4:  16px
--spacing-5:  20px
--spacing-6:  24px
--spacing-7:  32px
--spacing-8:  40px
--spacing-9:  48px
--spacing-10: 56px
--spacing-11: 64px
--spacing-12: 72px
--spacing-13: 80px
--spacing-14: 120px
```

**Usage in Tailwind**: Use standard Tailwind spacing classes (p-4, m-6, etc.) which map to this scale.

---

## Border Radius System

```css
--radius-0:  0px
--radius-1:  4px
--radius-2:  8px
--radius-3:  12px
--radius-4:  16px
--radius-5:  20px
--radius-6:  24px
--radius-7:  32px
--radius-8:  40px
--radius-9:  48px
--radius-10: 56px
--radius-11: 64px
--radius-12: 72px
--radius-13: 80px
--radius-full: 999px
```

**CSS Classes**: `.radius-0` through `.radius-13`, `.radius-full`

---

## Stroke/Border Width System

```css
--stroke-0: 0px
--stroke-1: 1px
--stroke-2: 2px
--stroke-3: 3px
--stroke-4: 4px
--stroke-5: 5px
--stroke-6: 6px
--stroke-7: 8px
--stroke-8: 10px
--stroke-9: 12px
```

**CSS Classes**: `.stroke-0` through `.stroke-9`

---

## Shadow System

```css
.shadow {
  box-shadow: 
    0px 7px 15px rgba(0, 0, 0, 0.08),
    0px 28px 28px rgba(0, 0, 0, 0.07);
}
```

---

## Scrollbar Styling

### Hidden Scrollbar
```css
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
```

### Thin Scrollbar
```css
.scrollbar-thin {
  scrollbar-width: thin;
  scrollbar-color: #A7A7A7 #F4F4F4;
}
.scrollbar-thin::-webkit-scrollbar {
  width: 6px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: #F4F4F4;
  border-radius: 3px;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background: #A7A7A7;
  border-radius: 3px;
}
.scrollbar-thin::-webkit-scrollbar-thumb:hover {
  background: #777777;
}
```

---

## Input Styling

### Number Input (No Arrows)
All number inputs should have arrows/spinners removed:
```css
input[type="number"]::-webkit-inner-spin-button,
input[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type="number"] {
  -moz-appearance: textfield;
  appearance: textfield;
}
```

---

## Component Guidelines

### Buttons
- Use `.text-btn-sm`, `.text-btn-md`, or `.text-btn-lg` for text sizing
- Primary buttons should use `bg-gradient` or violet/rose primary colors
- Secondary buttons can use Imperial Red or other secondary colors
- Border radius: typically `.radius-2` to `.radius-4` (8px-16px)

### Cards
- Background: White or light gray (--gray-50)
- Border radius: `.radius-3` to `.radius-5` (12px-20px)
- Shadow: Use `.shadow` class
- Spacing: Consistent padding using spacing scale

### Forms
- Input borders: Gray-300 (`#D1D5DB`)
- Focus state: Violet-500 or brand gradient
- Disabled state: Gray-100 background
- Placeholder text: `.text-placeholder`
- Icons inside inputs: Gray-500

### Tables
- Header background: Gray-900 (`#111827`)
- Striped rows: Gray-100 background
- Border: Gray-200

---

## Best Practices

### DO:
✅ Always use the defined spacing scale (--spacing-0 through --spacing-14)
✅ Use semantic color names from the palette
✅ Apply consistent border radius from the radius scale
✅ Use Plus Jakarta Sans for all typography
✅ Follow the type scale for headings and body text
✅ Use `.scrollbar-thin` for better UX on scrollable areas
✅ Apply `.shadow` for elevated components
✅ Use the brand gradient for primary CTAs and hero sections

### DON'T:
❌ Use arbitrary spacing values not in the scale
❌ Mix fonts or use system fonts except as fallback
❌ Use colors outside the defined palette
❌ Apply inconsistent border radius values
❌ Show number input spinners/arrows
❌ Use default browser scrollbars without styling

---

## DeFi-Specific Considerations

### Trading Interface
- Use Imperial Red (#FC5457) for sell/short actions
- Use Electric Blue or Violet for buy/long actions
- Display leverage clearly with appropriate warning colors
- Use monospace fonts for numerical data (prices, amounts)

### Data Visualization
- Use gradient for positive trends
- Use Imperial Red for negative trends
- Maintain WCAG AA contrast ratios for readability

### Wallet Connection
- Use violet primary for connect buttons
- Show connection status with color indicators
- Display addresses in monospace with proper truncation

---

## Code Examples

### Button Component
```jsx
<button className="bg-gradient text-white text-btn-md px-6 py-3 radius-3 shadow">
  Open Position
</button>
```

### Card Component
```jsx
<div className="bg-white radius-4 shadow p-6">
  <h3 className="text-h7 text-heading mb-4">Your Position</h3>
  <p className="text-body-2 text-paragraph">Content here</p>
</div>
```

### Input Component
```jsx
<input 
  type="number"
  placeholder="Enter amount"
  className="w-full px-4 py-3 radius-2 stroke-1 border-gray-300 text-body-1 text-placeholder focus:border-violet-500"
/>
```

---

## Accessibility

- Maintain WCAG AA compliance (4.5:1 contrast ratio for normal text)
- Use semantic HTML elements
- Ensure interactive elements have clear focus states
- Provide alt text for images and icons
- Support keyboard navigation

---

## File Organization

When creating new components:
```
/components
  /ui           # Reusable UI components
  /forms        # Form components
  /layout       # Layout components
  /trading      # DeFi-specific components
```

Always import the global CSS with theme variables:
```tsx
import '@/app/globals.css';
```

---

## Quick Reference

**Primary Actions**: Violet-500 (#703AE6) or gradient
**Destructive Actions**: Imperial Red-500 (#FC5457)
**Success States**: Electric Blue-500 (#32EEE2)
**Neutral Actions**: Gray scale
**Headings**: Semibold (600 weight)
**Body Text**: Regular (400 weight)
**Buttons**: Semibold (600 weight)

---

## Version
Last Updated: February 2026
Brand Guidelines Version: 1.0
Project: Vanna Finance - DeFi Derivatives Trading Protocol