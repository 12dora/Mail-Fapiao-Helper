import type { SiteHandler } from './types.js';
import nuonuoHandler from './nuonuo.js';
import taobaoHandler from './taobao.js';
import taobaoFlashHandler from './taobaoFlash.js';
import jdHandler from './jd.js';
import keruyunHandler from './keruyun.js';
import baiwangHandler from './baiwang.js';
import pinganHandler from './pingan.js';
import taxPreviewHandler from './taxPreview.js';
import huaweiTravelHandler from './huaweiTravel.js';

export const handlers: SiteHandler[] = [];

handlers.push(nuonuoHandler);
handlers.push(taobaoHandler);
handlers.push(taobaoFlashHandler);
handlers.push(jdHandler);
handlers.push(keruyunHandler);
handlers.push(baiwangHandler);
handlers.push(pinganHandler);
handlers.push(taxPreviewHandler);
handlers.push(huaweiTravelHandler);
