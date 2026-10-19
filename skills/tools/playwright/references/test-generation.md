# Test Generation

Generate Playwright test code automatically as you interact with the browser.

## How It Works

Every action you perform with `playwright-cli` generates corresponding Playwright TypeScript code.
This code appears in the output and can be copied directly into your test files.

## Example Workflow

```bash
# Start a session
playwright-cli open https://example.com/login

# Take a snapshot to see elements
playwright-cli snapshot
# Output shows: e1 [textbox "Email"], e2 [textbox "Password"], e3 [button "Sign In"]

# Fill form fields - generates code automatically
playwright-cli fill e1 "user@example.com"
# Ran Playwright code:
# await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');

playwright-cli fill e2 "password123"
# Ran Playwright code:
# await page.getByRole('textbox', { name: 'Password' }).fill('password123');

playwright-cli click e3
# Ran Playwright code:
# await page.getByRole('button', { name: 'Sign In' }).click();
```

## Building a Test File

Collect the generated code into a Playwright test:

```typescript
import { test, expect } from '@playwright/test';

test('login flow', async ({ page }) => {
  // Generated code from playwright-cli session:
  await page.goto('https://example.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('password123');
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Add assertions
  await expect(page).toHaveURL(/.*dashboard/);
});
```

## Best Practices

### 1. Use Semantic Locators

The generated code uses role-based locators when possible, which are more resilient:

```typescript
// Generated (good - semantic)
await page.getByRole('button', { name: 'Submit' }).click();

// Avoid (fragile - CSS selectors)
await page.locator('#submit-btn').click();
```

### 2. Explore Before Recording

Take snapshots to understand the page structure before recording actions:

```bash
playwright-cli open https://example.com
playwright-cli snapshot
# Review the element structure
playwright-cli click e5
```

### 3. Add Assertions Manually

Generated code captures actions, not assertions. Derive expectations from the
intended behavior or acceptance criteria, then compare them with the actual
page state using these matchers:

- `toBeVisible()` — element is rendered and visible
- `toHaveText(text)` — element text content matches
- `toHaveValue(value)` — input/select value matches
- `toBeEmpty()` — input has no value
- `toBeChecked()` / `toBeChecked({ checked: false })` — checkbox state matches
- `toMatchAriaSnapshot(snapshot)` — page (or locator) matches a partial accessibility snapshot

Use `playwright-cli generate-locator <target>` for the assertion locator.
Snapshot/eval commands inspect actual state; their output is evidence to check
against the requirements, not the source of expected values.

When asserting text content, make sure that generated locator does not contain text from the element itself. `getByTestId()` or `getByLabel()` usually work well with asserting text. When locator is text-based, prefer `toBeVisible()` instead.

Write expected ARIA snapshots from the intended accessible structure, scoped
to the behavior under test. Use regular expressions only for variation that
the requirements allow.

```bash
# Illustrative refs from a current snapshot: e5 Submit button, e6 welcome
# heading, e7 Email textbox, e8 notifications checkbox, e9 navigation.
# Get a stable locator for an element ref to use in the assertion
playwright-cli --raw generate-locator e5
# getByRole('button', { name: 'Submit' })

# Inspect actual text content for comparison with intended text
playwright-cli --raw eval "el => el.textContent" e6

# Inspect the actual input value for toHaveValue/toBeEmpty
playwright-cli --raw eval "el => el.value" e7

# Inspect the actual checkbox state for toBeChecked
playwright-cli --raw eval "el => el.checked" e8

# Inspect the actual accessible structure for toMatchAriaSnapshot
# (whole page, or use a ref to scope to a region)
playwright-cli --raw snapshot
playwright-cli --raw snapshot e9
```

```typescript
// Generated action
await page.getByRole('button', { name: 'Submit' }).click();

// Illustrative expectations from the intended signed-in page behavior:
await expect(page.getByRole('alert', { name: 'Success' })).toBeVisible();
await expect(page.getByTestId('main-header')).toHaveText('Welcome, user');
await expect(page.getByRole('textbox', { name: 'Email' })).toHaveValue('user@example.com');
await expect(page.getByRole('checkbox', { name: 'Enable notifications' })).toBeChecked();

// Require the intended signed-in controls in a matching page region
await expect(page).toMatchAriaSnapshot(`
  - heading "Welcome, user"
  - link /\\d+ new messages?/
  - button "Sign out"
`);

// Require the intended links in the navigation region
await expect(page.getByRole('navigation')).toMatchAriaSnapshot(`
  - link "Home"
  - link /\\d+ new messages?/
  - link "Profile"
`);
```
