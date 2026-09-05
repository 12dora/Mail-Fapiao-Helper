import 'dayjs/locale/zh-cn.js';
import dayjs from 'dayjs';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { startEventHub } from './bridge/index.js';
import './app.css';

dayjs.locale('zh-cn');

// preload 每个通道只保留一个监听器，所以订阅必须在应用启动时集中注册一次。
startEventHub();

const container = document.getElementById('root');
if (!container) throw new Error('缺少挂载点 #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
