(function () {
  const currentDesign = document.currentScript.dataset.design;
  const cookieName = 'ops_design_v1';

  function chooseDesign(design) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const preference = cookieName + '=' + design;
    document.cookie = preference + '; Path=/; Max-Age=31536000; SameSite=Lax' + secure;
    if (!document.cookie.split(';').some(cookie => cookie.trim() === preference)) {
      document.getElementById('opsDesignError').textContent = 'デザインを保存できませんでした。ブラウザのCookie設定をご確認ください。';
      return;
    }
    if (design === currentDesign) closeSheet();
    else location.reload();
  }

  window.openDesignSwitch = function () {
    openSheet(
      '<h3>デザイン切り替え</h3><div class="btn-row">' +
      [['legacy', '旧版'], ['latest', '最新版']].map(([design, label]) =>
        '<button type="button" class="btn' + (currentDesign === design ? ' pri' : '') +
        '" data-ops-design="' + design + '" aria-pressed="' + (currentDesign === design) + '">' + label + '</button>'
      ).join('') + '</div><p class="fine" id="opsDesignError" role="status"></p>'
    );
    const buttons = document.querySelectorAll('#sheet [data-ops-design]');
    buttons.forEach(button => button.addEventListener('click', () => chooseDesign(button.dataset.opsDesign)));
    document.querySelector('#sheet [aria-pressed="true"]').focus();
  };
})();
