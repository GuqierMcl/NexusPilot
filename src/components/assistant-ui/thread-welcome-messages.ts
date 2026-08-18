export const THREAD_WELCOME_MESSAGES = [
  "今天想拆哪段 SQL？",
  "数据库今天哪里不太乖？",
  "把慢查询摊开看看？",
  "今天追哪条数据线索？",
  "想让哪张表开口说话？",
  "把报错递来，我们慢慢拆。",
  "来给查询提提速。",
  "哪条索引需要灵感？",
  "今天让数据更听话一点？",
  "SQL 迷路了？我来点灯。",
  "准备给数据库做体检？",
  "今天要挖哪份数据真相？",
  "把问题放上来，一起破案。",
  "哪段执行计划有戏？",
  "让表结构露两手？",
  "今天给哪条查询松松筋？",
] as const;

export function pickThreadWelcomeMessage(
  random: () => number = Math.random,
): string {
  const index = Math.min(
    Math.floor(random() * THREAD_WELCOME_MESSAGES.length),
    THREAD_WELCOME_MESSAGES.length - 1,
  );
  return THREAD_WELCOME_MESSAGES[index]!;
}
