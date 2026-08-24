/* 壳层就绪信号（经典脚本，必须 parser-blocking）。
 *
 * shell.js 拆成 ES 模块后是 `type="module"`，也就是 defer 执行；而各页面底部
 * 的内联控制器仍是经典脚本，在解析阶段就跑完并绑好了按钮。两者之间存在一个
 * 窗口：模块图还没加载完，window.FPH 尚不存在。这段时间里内联控制器中所有
 * `window.FPH?.…` 都会被可选链静默跳过——包括 dashboard 的
 * whenConfigReady()，于是发出的是 HTML 里的静态默认值而不是用户存盘的配置。
 *
 * 本文件先于 shell.js 以经典脚本方式加载，保证内联控制器解析时
 * window.MFH_SHELL_READY 已经存在，可以 await 到壳层就绪。
 */
(function () {
    'use strict';
    // SPA 导航会重放页面脚本；已经建过就不要再换一个未决的 promise，
    // 否则导航后 await 会永远挂住（shell.js 不会被重复执行来兑现它）。
    if (window.MFH_SHELL_READY) return;
    var resolve;
    window.MFH_SHELL_READY = new Promise(function (r) { resolve = r; });
    window.__mfhShellReady = function () { resolve(); };
})();
