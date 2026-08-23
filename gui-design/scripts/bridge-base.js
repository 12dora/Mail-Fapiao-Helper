import { showToast } from './toast.js';

export function bridgeUnavailable() {
    showToast('请在桌面版中使用', '这个操作需要调用本机程序。静态预览只能查看界面。', 'warn');
}

