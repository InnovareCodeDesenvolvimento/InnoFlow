import { expect, test } from "@playwright/test"

test("a home carrega e mostra o título InnoElektron", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "InnoElektron" })).toBeVisible()
})
