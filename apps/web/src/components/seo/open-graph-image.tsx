import { ImageResponse } from 'next/og'

export const OPEN_GRAPH_IMAGE_SIZE = { height: 630, width: 1200 }

export function createOpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: 'stretch',
          background: '#f6f8f3',
          color: '#17251e',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'Arial, sans-serif',
          height: '100%',
          justifyContent: 'space-between',
          padding: '72px 84px',
          width: '100%',
        }}
      >
        <div style={{ alignItems: 'center', display: 'flex', fontSize: 30, fontWeight: 700 }}>
          <div
            style={{
              alignItems: 'center',
              background: '#236245',
              borderRadius: 16,
              color: '#ffffff',
              display: 'flex',
              height: 64,
              justifyContent: 'center',
              marginRight: 24,
              width: 64,
            }}
          >
            W
          </div>
          Wanmi.net
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ color: '#236245', fontSize: 28, fontWeight: 700, marginBottom: 22 }}>
            中文域名工具与服务入口
          </div>
          <div
            style={{
              fontSize: 72,
              fontWeight: 750,
              letterSpacing: '-3px',
              lineHeight: 1.1,
              maxWidth: 940,
            }}
          >
            查清域名状态，再决定下一步。
          </div>
        </div>
        <div style={{ color: '#5d6a63', display: 'flex', fontSize: 24 }}>
          域名查询 · WHOIS · DNS · SSL · IDN · TLD 价格
        </div>
      </div>
    ),
    OPEN_GRAPH_IMAGE_SIZE,
  )
}
