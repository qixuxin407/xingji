# 行迹 Xingji · 个人旅行星球

一个可拖拽旋转的 3D 地球旅行记录应用。可以搜索并标记到过的城市或行政区，查看亮线轮廓、呼吸光点、时间线票根、照片集和日记。所有旅行内容都保存在你自己的浏览器里，不会上传到服务器。

## 本地使用

### Windows 一键启动

1. 打开项目文件夹。
2. 双击 `start-xingji.bat`。
3. 浏览器会自动打开 `http://127.0.0.1:5173`。
4. 不使用时，关闭那个黑色命令行窗口即可。

首次使用需要电脑上安装 Node.js 18 或更新版本，推荐从 [Node.js 官网](https://nodejs.org/) 下载 LTS 版本。项目的 Three.js、地球纹理、中国区划索引和国界数据已经内置在 `vendor/` 和 `assets/` 中，所以日常启动不需要执行 `npm install`。

### 命令启动

```bash
npm start
```

然后访问 `http://127.0.0.1:5173`。如果端口被占用，再次运行会自动打开已存在的行迹页面。

> 不能直接双击 `index.html`。浏览器对 `file://` 页面里的 ES Module 有跨域限制，必须通过本地 HTTP 服务打开。

## 主要功能

- 3D 地球拖拽、缩放和城市飞行动画。
- 中国省 / 市 / 区索引与基础世界国界。
- 足迹高亮轮廓与呼吸光点。
- 城市卡片、旅行详情页、按日照片集和日记。
- 全屏时间线页面和自定义票根封面。
- 照片、日记、封面、地点信息都可在页面内编辑。
- 支持导出 / 导入完整备份。

## 数据保存在哪里

数据保存在当前浏览器，不上传到 GitHub 或任何服务器：

| 内容 | 位置 |
| --- | --- |
| 足迹、行程信息、日记、照片索引 | 浏览器 `localStorage`，键名为 `xingji.v1` |
| 照片与时间线封面 | 浏览器 IndexedDB，数据库名为 `xingji-media.v1` |
| 行政区边界缓存 | 浏览器 IndexedDB，数据库名为 `xingji-geo.v1` |

清理浏览器数据、使用隐私窗口或换浏览器都会让这些数据看起来“消失”。建议定期使用主页左侧下方的“导出备份”保存 JSON 文件。导出文件包含足迹、日记、照片、封面和边界缓存。换电脑或换浏览器时，用“导入备份”恢复。

浏览器把不同的网址来源视为不同空间，所以本地 `127.0.0.1:5173` 和 GitHub Pages 的数据不会自动互相同步。迁移时请使用导出 / 导入备份。

## 上传到 GitHub 并得到网址

### 1. 创建仓库

在 GitHub 新建一个仓库，例如 `xingji`。不要在网页上勾选自动生成的 README，避免和本地内容冲突。

### 2. 推送项目

在项目文件夹打开 PowerShell，把下面的 `你的用户名` 和 `xingji` 换成自己的信息：

```powershell
git init
git add .
git commit -m "Initial Xingji travel globe"
git branch -M main
git remote add origin https://github.com/你的用户名/xingji.git
git push -u origin main
```

如果仓库已经初始化过，只需要确认远程地址并执行 `git add`、`git commit`、`git push`。

### 3. 开启 GitHub Pages

项目已包含 `.github/workflows/deploy.yml`。推送后进入仓库：

1. 打开 **Settings**。
2. 左侧选择 **Pages**。
3. 在 **Build and deployment** 里把 **Source** 设置为 **GitHub Actions**。
4. 等 Actions 运行完成后，访问 `https://你的用户名.github.io/xingji/`。

这个在线网址可以直接使用。搜索服务没有本地代理时会自动回退到远程服务，所以 GitHub Pages 上也能搜索和加载边界。

## 素材与服务说明

- 地球纹理：NASA Blue Marble。
- 世界国界：Natural Earth / world-atlas。
- 中国行政区划索引与边界：阿里云 DataV。
- 国际行政区搜索与边界：Photon、OpenStreetMap / Overpass API。
- Three.js：MIT License。

请注意遵守上游数据的许可要求。个人旅行照片、日记和备份文件属于私人内容，建议不要提交到公开仓库。
