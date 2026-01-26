# pluxel-plugin-s3mini

基于 `s3mini` 的 S3 兼容对象存储插件（Node/Bun/Edge 环境可用），并提供**按 caller 插件 ID 自动分 scope 的 key 前缀**，避免多插件共用同一 bucket 时 key 冲突。

## 配置（default.json）

插件名是 `S3Mini`，本插件的配置字段挂在 `plugins.S3Mini.config`。

最常用（直接给 bucket endpoint）：

```json
{
  "json": {
    "enabled": ["S3Mini"],
    "plugins": {
      "S3Mini": {
        "config": {
          "endpoint": "https://<bucket>.<region>.digitaloceanspaces.com",
          "region": "auto",
          "keyPrefix": "pluxel/",
          "scopeByCaller": true,
          "publicBaseURL": "https://cdn.example.com/"
        }
      }
    }
  }
}
```

也支持 base endpoint + bucket（会自动拼成 bucket endpoint）：

```json
{
  "json": {
    "enabled": ["S3Mini"],
    "plugins": {
      "S3Mini": {
        "config": {
          "endpoint": "https://s3.us-east-1.amazonaws.com",
          "bucket": "my-bucket",
          "endpointStyle": "virtualHost"
        }
      }
    }
  }
}
```

凭证：优先用配置里的 `accessKeyId` / `secretAccessKey`，否则会读取环境变量：
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`

## 使用

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { S3MiniPlugin } from 'pluxel-plugin-s3mini'

@Plugin({ name: 'MyPlugin', type: 'service' })
export class MyPlugin extends BasePlugin {
	constructor(private s3: S3MiniPlugin) {
		super()
	}

	async init() {
		// 默认 scope() 会用 caller id 作为前缀：MyPlugin/...
		await this.s3.put('hello.txt', 'hello', { contentType: 'text/plain; charset=utf-8' })
		const url = this.s3.scope().publicURL('hello.txt')
		this.ctx.logger.info('public url ({url})', { url })
	}
}
```
