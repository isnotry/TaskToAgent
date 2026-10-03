import React from 'react';
import ReactDOM from 'react-dom/client';
import '@arco-design/web-react/dist/css/arco.css';
import App from './App';
import { I18nProvider } from './i18n';

// I18nProvider 必须在 App 外层：App 及其子组件都要通过 useI18n() 取当前语言文案。
ReactDOM.createRoot(document.getElementById('root')).render(
  <I18nProvider>
    <App />
  </I18nProvider>
);
