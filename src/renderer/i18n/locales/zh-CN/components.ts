/** 通用小组件文案（文件树、代码查看器、渲染错误边界） */

export const components = {
  fileTree: {
    title: '项目文件',
    refresh: '刷新文件树',
    empty: '工作目录暂无文件',
    emptyHint: '（Agent 生成的代码会出现在这里）',
    openHint: '{path}（双击打开）',
    openWave: '用 GTKWave 打开波形'
  },
  codeViewer: {
    findPlaceholder: '查找文件内容',
    findAriaLabel: '查找内容',
    noResults: '无结果',
    previous: '上一个',
    next: '下一个',
    loading: '正在加载代码查看器...'
  },
  errorBoundary: {
    title: '界面组件发生异常',
    description: 'MoonGlass 已隔离本次界面错误，项目文件和 Agent 会话不会丢失。请重新加载界面；若问题重复出现，可根据下方信息定位。',
    reload: '重新加载界面'
  }
}

export type ComponentsMessages = typeof components
