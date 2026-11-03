import { startAgent } from './server'

/**
 * agent 的运行入口（`npm start` = `vite-node src/main.ts`）。
 *
 * 与 server.ts 的分工：server.ts 是纯库（导出 createAgentServer/handleExec/startAgent，
 * 供单测与集成测 import 而无副作用），main.ts 才真正读环境变量并起监听。这样无论从哪个
 * runner（vite-node / node 产物）进来，只要跑的是本文件就一定启动服务器——不像旧的
 * argv 嗅探那样依赖 runner 往 process.argv 里塞目标路径。
 */
startAgent()
