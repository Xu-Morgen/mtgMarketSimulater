# Jobs Application

定义入队、调度、恢复与任务处理用例。`catalog.sync`、`prices.sync`、`daily.rollover`、`market.reprice`、`tournament.settle`、`order.expire` 与 `backup.create` 均应从这里被编排。市场报价有效期为 15 分钟，runner 每 10 分钟以最近成功外部快照投递一次 `market.reprice`；任务按时间桶去重、报价按 UTC 日覆盖，避免无成交时全部报价永久过期。`narrative.generate` 仅为 I33 发布后 I34 的可选预留任务，首发不得投递或领取。
