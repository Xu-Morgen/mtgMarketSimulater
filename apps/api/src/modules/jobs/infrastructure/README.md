# Jobs Infrastructure

实现 SQLite `jobs` 仓储与单实例串行 worker。领取和状态转换需使用条件更新，进程重启后可安全恢复未完成任务。
