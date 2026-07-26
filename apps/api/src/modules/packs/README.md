# Packs Module

拥有补充包商品、卡池、概率与开包记录。I11B 建立版本化规则配置、只读概率公示和服务端 CSPRNG 种子审计；I12B 已将开包结果、扣款、库存增加、事实事件与审计放入同一幂等短事务。迁移 `0013_base_bro_sos_packs.sql` 创建 `BRO-BASE` 与 `SOS-BASE` 基础商品；它们由 catalog application 在成功目录同步的同一事务中发布按系列隔离的不可变候选池快照。MVP 不启用保底机制，I17B 前不计算开包价格或盈亏。
