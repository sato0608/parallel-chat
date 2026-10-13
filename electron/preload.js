// レンダラーに公開するのはフォルダ選択ダイアログだけ
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pcNative', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
