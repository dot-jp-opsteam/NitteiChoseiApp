/* 予約とOPStappyの --serve で起動したlocalhostの一時DB専用。 */
import assert from 'node:assert/strict';

const BOOKING = 'http://localhost:8125';
const TALLY = 'http://localhost:8129';
const BOOKING_STAFF = {Authorization: 'Bearer bk_token_a'};
const TALLY_STAFF = {Authorization: 'Bearer tly_token_a'};

async function switchDesign(page, label, version) {
  if (await page.locator('#sbBurger').isVisible()) await page.locator('#sbBurger').click();
  await page.getByRole('button', {name: 'デザイン切り替え', exact: true}).click();
  assert.equal(await page.locator('#sheet [aria-pressed="true"]').count(), 1);
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', {name: label, exact: true}).click(),
  ]);
  await checkDesign(page, version);
}

async function checkDesign(page, version) {
  assert.equal(await page.locator('script[src="/design-switch.js"]').getAttribute('data-design'), version);
  await page.getByRole('button', {name: 'デザイン切り替え', exact: true}).waitFor();
}

async function json(response) {
  assert.ok(response.ok(), response.status() + ' ' + await response.text());
  return response.json();
}

export async function runDesignBrowserTests(browser) {
  const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'Asia/Tokyo'});
  try {
    const staff = await ctx.newPage();
    const publicPage = await ctx.newPage();
    async function login(page, base, token) {
      await page.goto(base + '/api/health');
      await page.evaluate(value => sessionStorage.setItem('ops_token_v1', value), token);
      await page.goto(base);
    }

    await login(staff, BOOKING, 'bk_token_a');
    await checkDesign(staff, 'legacy');
    const otherTab = await ctx.newPage();
    await login(otherTab, BOOKING, 'bk_token_a');
    await checkDesign(otherTab, 'legacy');
    await switchDesign(staff, '最新版', 'latest');
    await staff.reload();
    await checkDesign(staff, 'latest');
    await otherTab.getByRole('button', {name: 'デザイン切り替え', exact: true}).click();
    await otherTab.getByRole('button', {name: '旧版', exact: true}).click();
    await otherTab.close();
    await staff.reload();
    await checkDesign(staff, 'legacy');
    await switchDesign(staff, '最新版', 'latest');
    const config = {
      title: '両版で予約', duration: 30, minNoticeHours: 0, maxDays: 14,
      location: {type: 'none'},
      weekly: Object.fromEntries(Array.from({length: 7}, (_, day) => [day, [{s: '09:00', e: '22:00'}]])),
      fields: {name: 'required', email: 'off', affiliation: 'required', note: 'optional'},
    };
    const {page: booking} = await json(await staff.request.post(BOOKING + '/api/booking-pages', {headers: BOOKING_STAFF, data: {config}}));
    await publicPage.goto(booking.url);
    await publicPage.locator('.bk-slot:visible').first().click();
    await publicPage.getByRole('button', {name: '次へ', exact: true}).click();
    await publicPage.locator('#bkName').fill('最新版からの予約');
    await publicPage.locator('#bkAff').fill('テスト所属');
    const [saved] = await Promise.all([publicPage.waitForResponse(r => r.url().includes('/api/book/') && r.request().method() === 'POST'), publicPage.locator('#bkSubmit').click()]);
    const {booking: reservation} = await json(saved);

    await switchDesign(staff, '旧版', 'legacy');
    await staff.reload();
    await checkDesign(staff, 'legacy');
    await publicPage.goto(reservation.manage_url);
    await publicPage.getByText('最新版からの予約', {exact: false}).first().waitFor();
    await publicPage.goto(booking.url);
    await publicPage.locator('.bk-slot:visible').first().click();
    assert.equal(await publicPage.locator('#bkEmail').count(), 0);
    await publicPage.locator('#bkLast').fill('旧版からの');
    await publicPage.locator('#bkFirst').fill('予約');
    await publicPage.locator('#bkAffiliation').fill('旧版の所属');
    const [legacySaved] = await Promise.all([publicPage.waitForResponse(r => r.url().includes('/api/book/') && r.request().method() === 'POST'), publicPage.locator('#bkSubmit').click()]);
    const {booking: legacyReservation} = await json(legacySaved);
    await publicPage.getByText('このリンクを保存してください。', {exact: false}).waitFor();
    assert.equal(await publicPage.getByText('招待をお送りしました', {exact: false}).count(), 0);
    await switchDesign(staff, '最新版', 'latest');
    await publicPage.goto(legacyReservation.manage_url);
    await publicPage.getByText('旧版からの 予約', {exact: false}).first().waitFor();
    console.log('予約の公開URLと変更用リンクを両版で確認');

    await login(staff, TALLY, 'tly_token_a');
    await checkDesign(staff, 'latest');
    const tallyConfig = {
      title: '両版で回答', description: '', template: 'custom',
      rows: [{id: 'r1', label: '午前', active: true}],
      columns: [{id: 'c1', label: '月曜', active: true}, {id: 'c2', label: '火曜', active: true}],
    };
    const {board} = await json(await staff.request.post(TALLY + '/api/tally-boards', {headers: TALLY_STAFF, data: {config: tallyConfig}}));
    await switchDesign(staff, '旧版', 'legacy');
    await publicPage.goto(board.url);
    await publicPage.locator('#open-answer').click();
    await publicPage.locator('#name').fill('切り替え前の回答');
    await publicPage.locator('#editor .tly-choice').first().click();
    await publicPage.locator('#submit').click();
    const editLink = publicPage.locator('#receipt a');
    await editLink.waitFor();
    const editUrl = TALLY + await editLink.getAttribute('href');
    await switchDesign(staff, '最新版', 'latest');
    await publicPage.goto(editUrl);
    await publicPage.locator('#name').waitFor();
    assert.equal(await publicPage.locator('#name').inputValue(), '切り替え前の回答');
    await publicPage.locator('#name').fill('切り替え後の回答');
    await publicPage.locator('#submit').click();
    await publicPage.locator('#summary').getByText('切り替え後の回答', {exact: true}).waitFor();
    await switchDesign(staff, '旧版', 'legacy');
    await publicPage.goto(editUrl);
    await publicPage.locator('#name').waitFor();
    assert.equal(await publicPage.locator('#name').inputValue(), '切り替え後の回答');
    console.log('OPStappyの回答・本人編集リンク・更新を両版で確認');
  } finally {
    await ctx.close();
  }
}
