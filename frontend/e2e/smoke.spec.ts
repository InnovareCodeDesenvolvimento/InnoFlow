import { expect, test } from "@playwright/test"

test("a home carrega e mostra a marca InnoFlow", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("link", { name: "InnoFlow" }).first()).toBeVisible()
})
