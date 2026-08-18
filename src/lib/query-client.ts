import { QueryClient } from "@tanstack/react-query";

/**
 * 全局共享 QueryClient 实例。
 *
 * 提取为独立模块，使非组件代码（如断开连接时）也能调用
 * `queryClient.invalidateQueries()` 清除缓存，而无需通过 React context 传递。
 */
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // 缓存结果 30 秒，超过则视为过期
            staleTime: 30_000,
            // 默认不重试，Engine IPC hooks 可按需使用 shouldRetryIpcError 单独配置
            retry: false,
        },
    },
});
