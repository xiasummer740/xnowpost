/**
 * 生成 xray 配置：一个节点 + 一批本地 socks 入口（一个环境一条端口）。
 *
 * 为什么是「一批入口」而不是「一个入口大家共用」（2026-10-28）：
 *   现有架构就是一条环境一条端口（1080–1109），共用会让一个号的掉线/风控波及所有号，
 *   而且 FoxProfile 的每个环境要填自己的代理地址。端口固定开满 30 条的好处：
 *   新建环境时不用改配置、不用重启内核，只是把新环境指向一个还没人用的端口。
 *
 * 纯函数，单测 tests/unit/proxy-xray-config.test.js。
 */

/** 本机/内网地址直连，不要绕代理（不依赖 geoip.dat，显式列 CIDR） */
export const PRIVATE_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

export const DEFAULT_PORTS = Array.from({ length: 30 }, (_, i) => 1080 + i);

/**
 * @param {object} opts
 * @param {object} opts.outbound   parseProxyUri() 出来的 outbound
 * @param {number[]} [opts.ports]  要开的本地 socks 端口（默认 1080–1109）
 * @param {string} [opts.logLevel] xray 日志级别
 */
export function buildXrayConfig({ outbound, ports = DEFAULT_PORTS, logLevel = 'warning' } = {}) {
  if (!outbound || !outbound.protocol) throw new Error('没有可用的节点（outbound 为空）');
  const list = (Array.isArray(ports) ? ports : [])
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!list.length) throw new Error('没有可用的本地端口');

  const inbounds = list.map((port) => ({
    tag: `socks-${port}`,
    listen: '127.0.0.1',
    port,
    protocol: 'socks',
    // udp 关掉：Camoufox 的 socks 走 TCP；开 UDP 会让 DNS 走代理解析，出问题更难查
    settings: { udp: false, auth: 'noauth' },
    sniffing: { enabled: false },
  }));

  return {
    log: { loglevel: logLevel },
    inbounds,
    outbounds: [
      { ...outbound, tag: 'proxy' },
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', ip: PRIVATE_CIDRS, outboundTag: 'direct' },
        // 兜底：其余全部走节点
        { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
      ],
    },
  };
}

export default { buildXrayConfig, DEFAULT_PORTS, PRIVATE_CIDRS };
