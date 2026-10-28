XNOWPost 内置代理内核说明
==========================

本软件内置 xray-core（xray.exe），用于把用户提供的代理节点
（vless / vmess / trojan / shadowsocks / socks5 / http）转换成本机 socks 通道，
供指纹浏览器环境出网。

- 项目：https://github.com/XTLS/Xray-core
- 许可证：Mozilla Public License 2.0 (MPL-2.0)
- 完整许可证文本：https://www.mozilla.org/en-US/MPL/2.0/
- Xray-core 的源代码可向 https://github.com/XTLS/Xray-core 获取。

本软件未修改 xray-core 源码，仅以独立进程调用（`xray.exe run -c config.json`）。
配置文件由本软件在运行期生成（%APPDATA%\xnowpost\data\xray\config.json）。
