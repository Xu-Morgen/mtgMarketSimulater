/**
 * I04 的最小 OpenAPI 文档源。端点实现新增或变更时必须在此同步；测试会校验文档的
 * 基本结构及公开路由集合，防止 HTTP 协议只存在于实现中。
 */
export const publicApiPaths = [
  "/health",
  "/ready",
  "/openapi.json",
  "/v1/market/quotes",
  "/v1/market/quotes/{skuId}",
  "/v1/market/quotes/{skuId}/history",
  "/v1/market/index",
  "/v1/market/index/history",
  "/v1/npc-trades/buy/{skuId}/preview",
  "/v1/npc-trades/buy/{skuId}",
  "/v1/npc-trades/sell/{skuId}/preview",
  "/v1/npc-trades/sell/{skuId}",
  "/v1/orders/buy/{skuId}/preview",
  "/v1/orders/sell/{skuId}/preview",
  "/v1/orders/buy/{skuId}",
  "/v1/orders/sell/{skuId}",
  "/v1/orders",
  "/v1/orders/trades",
  "/v1/orders/trades/{tradeId}/fulfill",
  "/v1/orders/trades/{tradeId}/cancel",
  "/v1/orders/trades/{tradeId}/expire",
  "/v1/orders/{orderId}",
    "/v1/orders/{orderId}/cancel",
    "/v1/orders/book/{skuId}",
  "/v1/orders/{skuId}/match",
  "/v1/decks",
  "/v1/decks/validate",
  "/v1/decks/{deckId}",
  "/v1/tournaments",
  "/v1/tournaments/{tournamentId}/registration",
  "/v1/tournaments/{tournamentId}/result",
  "/v1/tournaments/{tournamentId}/register",
  "/v1/tournament-pack-grants",
  "/v1/tournament-pack-grants/{grantId}/claim",
  "/v1/player-tournament-pack-grants",
  "/v1/player-tournament-pack-grants/{grantId}/claim",
  "/v1/player-tournaments",
  "/v1/player-tournaments/{tournamentId}",
  "/v1/player-tournaments/{tournamentId}/registrations",
  "/v1/player-tournaments/{tournamentId}/result",
  "/v1/player-tournaments/{tournamentId}/join",
  "/v1/player-tournaments/{tournamentId}/withdraw",
  "/v1/player-tournaments/{tournamentId}/start",
  "/v1/player-tournaments/{tournamentId}/rounds",
  "/v1/player-tournaments/{tournamentId}/settle",
  "/v1/player-tournament-rounds/{roundId}/result",
  "/v1/player-tournament-rounds/{roundId}/confirm",
  "/v1/player-tournament-rounds/{roundId}/disputes",
  "/v1/admin/tournament-disputes/{disputeId}/resolve",
  "/v1/admin/player-tournaments/{tournamentId}/replay",
  "/v1/achievements",
  "/v1/achievements/unlocks",
  "/v1/achievements/detail",
  "/v1/auth/register",
  "/v1/auth/login",
  "/v1/auth/refresh",
  "/v1/auth/logout",
  "/v1/auth/session",
  "/v1/archive",
  "/v1/dashboard",
  "/v1/account",
  "/v1/ledger",
  "/v1/catalog/cards",
  "/v1/catalog/cards/{skuId}",
  "/v1/catalog/images/{imageName}",
  "/v1/prices/status",
  "/v1/packs",
  "/v1/packs/{packId}",
  "/v1/packs/{packId}/open",
  "/v1/store/packs",
  "/v1/store/packs/{packId}/purchase-preview",
  "/v1/pack-openings",
  "/v1/admin/jobs",
  "/v1/admin/jobs/{id}/retry",
  "/v1/admin/catalog/sync",
  "/v1/admin/prices/sync",
  "/v1/admin/prices/backfill",
  "/v1/admin/dashboard",
  "/v1/admin/audit-logs",
  "/v1/admin/audit-logs/{id}",
  "/v1/admin/exception-trades",
  "/v1/admin/campaigns",
  "/v1/admin/campaigns/{id}",
  "/v1/admin/campaigns/{id}/preview",
  "/v1/admin/campaigns/{id}/publish",
  "/v1/admin/campaigns/{id}/pause",
  "/v1/admin/campaigns/{id}/end",
  "/v1/admin/campaigns/{id}/schedule",
  "/v1/admin/users",
  "/v1/admin/users/{id}",
  "/v1/admin/users/{id}/freeze",
  "/v1/admin/users/{id}/unfreeze",
  "/v1/admin/users/{id}/revoke-sessions",
  "/v1/admin/users/{id}/compensate/balance",
  "/v1/admin/users/{id}/compensate/inventory",
  "/v1/admin/market-parameters",
  "/v1/admin/catalog/series",
  "/v1/admin/catalog/skus/{id}/tradable",
  "/v1/admin/catalog/sync-trigger",
  "/v1/admin/prices/sync-trigger",
  "/v1/admin/mtgjson/setlist-draft",
  "/v1/admin/mtgjson/drafts",
  "/v1/admin/mtgjson/drafts/{id}",
  "/v1/admin/mtgjson/drafts/{id}/preview",
  "/v1/admin/mtgjson/drafts/{id}/discard",
  "/v1/admin/packs/{packId}/rule-preview",
  "/v1/admin/packs/{packId}/rule-publish",
  "/v1/admin/packs/{packId}/disable"
] as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "MTG Market Simulator API", version: "v1" },
  paths: {
    "/health": { get: { summary: "存活检查", responses: { "200": { description: "服务存活" } } } },
    "/ready": {
      get: {
        summary: "就绪检查",
        responses: { "200": { description: "依赖可用" }, "503": { description: "依赖不可用" } }
      }
    },
    "/openapi.json": {
      get: { summary: "OpenAPI 3.1 文档", responses: { "200": { description: "API 协议文档" } } }
    },
    "/v1/market/quotes": {
      get: {
        summary: "按服务端筛选分页查询市场报价投影",
        responses: { "200": { description: "市场报价分页" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/market/quotes/{skuId}": {
      get: {
        summary: "查询某个 SKU 的服务端游戏内与 NPC 报价",
        responses: { "200": { description: "报价" }, "401": { description: "认证无效或过期" }, "404": { description: "无有效报价" } }
      }
    },
    "/v1/market/index": { get: { summary: "查询本服与外部市场指数", responses: { "200": { description: "市场指数" }, "401": { description: "认证无效或过期" } } } },
    "/v1/market/quotes/{skuId}/history": {
      get: {
        summary: "按自然日采样查询单卡参考价与游戏内价历史（7d/30d/all）",
        responses: { "200": { description: "单卡价格历史" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/market/index/history": {
      get: {
        summary: "按自然日采样查询全服市场指数历史（7d/30d/all）",
        responses: { "200": { description: "市场指数历史" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/npc-trades/buy/{skuId}/preview": {
      get: {
        summary: "取得服务端 NPC 买入预览、不可变报价标识和额度",
        responses: { "200": { description: "NPC 买入预览" }, "404": { description: "无可结算报价" }, "409": { description: "报价已过期" } }
      }
    },
    "/v1/npc-trades/buy/{skuId}": {
      post: {
        summary: "以限价和幂等键确认 NPC 买入",
        responses: { "201": { description: "成交已结算" }, "200": { description: "幂等重放" }, "400": { description: "请求无效或缺少幂等键" }, "404": { description: "无可结算报价" }, "409": { description: "报价过期、余额不足、额度或幂等冲突" } }
      }
    },
    "/v1/npc-trades/sell/{skuId}/preview": {
      get: {
        summary: "取得服务端 NPC 卖出预览、可用库存与不可变报价标识",
        responses: { "200": { description: "NPC 卖出预览" }, "404": { description: "无可结算报价" }, "409": { description: "报价已过期" } }
      }
    },
    "/v1/npc-trades/sell/{skuId}": {
      post: {
        summary: "以最低可接受价和幂等键确认 NPC 卖出",
        responses: { "201": { description: "成交已结算" }, "200": { description: "幂等重放" }, "400": { description: "请求无效或缺少幂等键" }, "404": { description: "无可结算报价" }, "409": { description: "报价过期、库存不足、额度或幂等冲突" } }
      }
    },
    "/v1/orders/buy/{skuId}/preview": {
      get: {
        summary: "取得服务端双边买单预览、限价带、费用、预计支出与预览版本",
        responses: { "200": { description: "买单预览" }, "404": { description: "无可结算报价" }, "409": { description: "报价已过期" } }
      }
    },
    "/v1/orders/sell/{skuId}/preview": {
      get: {
        summary: "取得服务端双边卖单预览、可用库存、保证金、预计到手与预览版本",
        responses: { "200": { description: "卖单预览" }, "404": { description: "无可结算报价" }, "409": { description: "报价已过期" } }
      }
    },
    "/v1/orders/buy/{skuId}": {
      post: {
        summary: "以未过期预览版本、限价和幂等键创建买单并原子预占资金",
        responses: { "201": { description: "委托已创建" }, "200": { description: "幂等重放" }, "400": { description: "请求无效或缺少幂等键" }, "404": { description: "无可结算报价" }, "409": { description: "预览/报价过期、余额不足、额度、限价越界或幂等冲突" } }
      }
    },
    "/v1/orders/sell/{skuId}": {
      post: {
        summary: "以未过期预览版本、限价和幂等键创建卖单并锁定库存、预占保证金",
        responses: { "201": { description: "委托已创建" }, "200": { description: "幂等重放" }, "400": { description: "请求无效或缺少幂等键" }, "404": { description: "无可结算报价" }, "409": { description: "预览/报价过期、库存不足、额度、限价越界或幂等冲突" } }
      }
    },
    "/v1/orders": {
      get: {
        summary: "分页查询当前玩家的双边委托",
        responses: { "200": { description: "委托分页" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/orders/trades": {
      get: {
        summary: "分页查询当前玩家作为买方或卖方的成交（脱敏对手身份，附待履约资产）",
        responses: { "200": { description: "玩家成交分页" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/orders/trades/{tradeId}/fulfill": {
      post: {
        summary: "以幂等键确认模拟履约：扣买方资金、库存转买方、结算卖方收入/费用、返还保证金、追加 p2p.trade.settled",
        responses: { "200": { description: "已履约或幂等重放" }, "400": { description: "缺少幂等键" }, "404": { description: "未找到该成交" }, "409": { description: "状态不可履约或幂等冲突" } }
      }
    },
    "/v1/orders/trades/{tradeId}/cancel": {
      post: {
        summary: "以幂等键取消模拟履约：退回买方资金、扣除卖方保证金、恢复卖方库存，不产生 p2p.trade.settled",
        responses: { "200": { description: "已取消或幂等重放" }, "400": { description: "缺少幂等键" }, "404": { description: "未找到该成交" }, "409": { description: "状态不可取消或幂等冲突" } }
      }
    },
    "/v1/orders/trades/{tradeId}/expire": {
      post: {
        summary: "管理员显式触发某笔成交的到期回收（推进为取消履约）",
        responses: { "200": { description: "已处理到期回收" }, "401": { description: "认证无效或过期" }, "403": { description: "需要管理员权限" } }
      }
    },
    "/v1/orders/{orderId}": {
      get: {
        summary: "查询当前玩家的某个双边委托详情",
        responses: { "200": { description: "委托详情" }, "404": { description: "未找到该委托" } }
      }
    },
    "/v1/orders/{orderId}/cancel": {
      post: {
        summary: "以幂等键撤单并释放未成交资金、库存与保证金预占",
        responses: { "200": { description: "已撤单或幂等重放" }, "400": { description: "缺少幂等键" }, "404": { description: "未找到该委托" }, "409": { description: "状态不可撤或幂等冲突" } }
      }
    },
    "/v1/orders/book/{skuId}": {
      get: {
        summary: "查询某个 SKU 的只读双边订单簿",
        responses: { "200": { description: "订单簿" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/orders/{skuId}/match": {
      post: {
        summary: "管理员显式触发某个 SKU 的双边委托撮合（价格—时间优先）",
        responses: { "200": { description: "撮合结果与成交列表" }, "401": { description: "认证无效或过期" }, "403": { description: "需要管理员权限" } }
      }
    },
    "/v1/decks": {
      get: { summary: "列出当前玩家已保存的 Commander 草稿", responses: { "200": { description: "卡组列表" }, "401": { description: "认证无效或过期" } } },
      post: { summary: "以幂等键保存 Commander 草稿；服务端返回合法性，不锁库存", responses: { "201": { description: "草稿已保存" }, "400": { description: "参数无效或缺少幂等键" }, "409": { description: "幂等冲突" } } }
    },
    "/v1/decks/validate": {
      post: { summary: "只读验证 Commander 草稿及可用库存，不写入或锁定", responses: { "200": { description: "合法性结果" }, "400": { description: "参数无效" }, "401": { description: "认证无效或过期" } } }
    },
    "/v1/decks/{deckId}": {
      get: { summary: "读取当前玩家的一份 Commander 草稿", responses: { "200": { description: "卡组详情" }, "404": { description: "卡组不存在" } } },
      put: { summary: "以幂等键更新 Commander 草稿；不锁库存", responses: { "200": { description: "草稿已更新" }, "400": { description: "参数无效或缺少幂等键" }, "404": { description: "卡组不存在" }, "409": { description: "幂等冲突" } } }
    },
    "/v1/tournaments": { get: { summary: "查询当前服务器自然日的个人 NPC 赛事", responses: { "200": { description: "个人赛事列表" }, "401": { description: "认证无效或过期" } } } },
    "/v1/tournaments/{tournamentId}/registration": { get: { summary: "查询当前玩家的赛事报名及评分快照", responses: { "200": { description: "报名" }, "404": { description: "尚未报名" } } } },
    "/v1/tournaments/{tournamentId}/result": { get: { summary: "查询已结算的个人 NPC 赛事结果与公开重放材料", responses: { "200": { description: "赛事结果" }, "404": { description: "尚未结算" } } } },
    "/v1/tournaments/{tournamentId}/register": { post: { summary: "以幂等键报名个人 NPC 赛事；评分成功后原子收费并锁定卡组库存", responses: { "201": { description: "报名成功" }, "200": { description: "幂等重放" }, "400": { description: "参数无效或缺少幂等键" }, "409": { description: "卡组版本、库存、赛事状态或幂等冲突" }, "503": { description: "Leyline 评分不可用；返回受控失败分类，不含卡表或 Provider 原始响应" } } } },
    "/v1/tournament-pack-grants": { get: { summary: "查询当前玩家已获得的补充包奖励凭证", responses: { "200": { description: "奖励补充包凭证" } } } },
    "/v1/tournament-pack-grants/{grantId}/claim": { post: { summary: "以幂等键领取 NPC 赛事补充包奖励并零费用开包", responses: { "201": { description: "奖励已开封" }, "200": { description: "幂等重放" }, "409": { description: "凭证已领取或幂等冲突" } } } },
    "/v1/player-tournament-pack-grants": { get: { summary: "查询当前玩家的玩家赛事补充包奖励凭证", responses: { "200": { description: "奖励补充包凭证" } } } },
    "/v1/player-tournament-pack-grants/{grantId}/claim": { post: { summary: "以幂等键领取玩家赛事补充包奖励并零费用开包", responses: { "201": { description: "奖励已开封" }, "200": { description: "幂等重放" }, "409": { description: "凭证已领取或幂等冲突" } } } },
    "/v1/player-tournaments": { post: { summary: "创建游戏内或现实桌 Commander 赛事", responses: { "201": { description: "赛事已创建" } } } },
    "/v1/player-tournaments/{tournamentId}": { get: { summary: "读取自己创建或报名的玩家赛事", responses: { "200": { description: "赛事详情" }, "404": { description: "无读取权限" } } } },
    "/v1/player-tournaments/{tournamentId}/registrations": { get: { summary: "读取自己参与的玩家赛事报名列表", responses: { "200": { description: "报名列表" }, "404": { description: "无读取权限" } } } },
    "/v1/player-tournaments/{tournamentId}/result": { get: { summary: "读取当前玩家的玩家赛事排名结果", responses: { "200": { description: "赛事结果" }, "404": { description: "尚未结算" } } } },
    "/v1/player-tournaments/{tournamentId}/join": { post: { summary: "报名玩家创建赛事；现实桌仅保存自填卡组名", responses: { "201": { description: "报名成功" } } } },
    "/v1/player-tournaments/{tournamentId}/withdraw": { post: { summary: "以幂等键退出未结算赛事；游戏内比赛同时释放卡组锁定", responses: { "200": { description: "已退出" } } } },
    "/v1/player-tournaments/{tournamentId}/start": { post: { summary: "以幂等键开始游戏内赛事并投递唯一结算任务", responses: { "202": { description: "已入队" } } } },
    "/v1/player-tournaments/{tournamentId}/rounds": { get: { summary: "读取自己参与的现实桌轮次与奖励位加赛桌", responses: { "200": { description: "轮次列表" }, "404": { description: "无读取权限" } } }, post: { summary: "创建现实桌瑞士轮配对", responses: { "201": { description: "配对完成" } } } },
    "/v1/player-tournaments/{tournamentId}/settle": { post: { summary: "由创建者结算游戏内多人赛事并释放比赛锁定", responses: { "200": { description: "赛事已结算" } } } },
    "/v1/player-tournament-rounds/{roundId}/result": { post: { summary: "同桌成员提交现实桌赛果", responses: { "200": { description: "赛果待全桌确认" } } } },
    "/v1/player-tournament-rounds/{roundId}/confirm": { post: { summary: "同桌成员确认赛果", responses: { "200": { description: "已确认或仍待确认" } } } },
    "/v1/player-tournament-rounds/{roundId}/disputes": { post: { summary: "同桌成员创建赛果争议", responses: { "201": { description: "争议已创建" } } } },
    "/v1/admin/tournament-disputes/{disputeId}/resolve": { post: { summary: "管理员以原因和赋分结案现实桌争议", responses: { "200": { description: "争议已结案" } } } },
    "/v1/admin/player-tournaments/{tournamentId}/replay": { get: { summary: "管理员读取非 NPC 赛事的 seed、配对与完整重放材料", responses: { "200": { description: "管理员重放材料" }, "404": { description: "赛事不存在" } } } },
    "/v1/achievements": {
      get: {
        summary: "读取当前玩家的受控成就定义及服务端进度",
        responses: { "200": { description: "成就定义与进度" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/achievements/unlocks": {
      get: {
        summary: "读取当前玩家的不可变成就解锁、奖励状态与赛事来源",
        responses: { "200": { description: "成就解锁列表" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/achievements/detail": {
      get: {
        summary: "按 definitionId 查询当前玩家的一项成就详情、奖励状态与来源",
        responses: { "200": { description: "成就详情" }, "401": { description: "认证无效或过期" }, "404": { description: "成就不存在" } }
      }
    },
    "/v1/auth/register": {
      post: {
        summary: "注册玩家账户并创建会话",
        responses: {
          "201": { description: "已注册" },
          "409": { description: "邮箱已存在" },
          "429": { description: "认证频率受限" }
        }
      }
    },
    "/v1/auth/login": {
      post: {
        summary: "登录并创建会话",
        responses: {
          "200": { description: "已登录" },
          "401": { description: "凭据无效" },
          "429": { description: "认证频率受限" }
        }
      }
    },
    "/v1/auth/refresh": {
      post: {
        summary: "轮换 refresh token",
        responses: {
          "200": { description: "会话已轮换" },
          "401": { description: "令牌无效或重放" },
          "403": { description: "CSRF 校验失败" }
        }
      }
    },
    "/v1/auth/logout": {
      post: {
        summary: "撤销当前 refresh token",
        responses: { "200": { description: "已登出" }, "403": { description: "CSRF 校验失败" } }
      }
    },
    "/v1/auth/session": {
      get: {
        summary: "查询当前 access token 会话",
        responses: { "200": { description: "当前用户" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/archive": {
      post: {
        summary: "创建唯一游戏存档并发放初始资金",
        responses: {
          "201": { description: "存档已创建或幂等重放" },
          "400": { description: "缺少幂等键" },
          "409": { description: "幂等冲突或处理中" }
        }
      },
      get: {
        summary: "查询当前用户的存档摘要与净资产占位",
        responses: { "200": { description: "存档摘要" }, "404": { description: "尚未创建存档" } }
      }
    },
    "/v1/dashboard": {
      get: {
        summary: "查询玩家首页的服务端聚合快照",
        responses: { "200": { description: "余额、净资产、收藏、今日资金/比赛、指数和待办" }, "404": { description: "尚未创建游戏存档" } }
      }
    },
    "/v1/account": {
      get: {
        summary: "查询账户总额、可用额与冻结额",
        responses: { "200": { description: "余额" }, "404": { description: "尚未创建账户" } }
      }
    },
    "/v1/ledger": {
      get: {
        summary: "分页查询当前用户不可变账本流水",
        responses: { "200": { description: "账本分页" } }
      }
    },
    "/v1/catalog/cards": {
      get: {
        summary: "按印刷 SKU 分页查询本地卡牌目录",
        responses: { "200": { description: "目录分页" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/catalog/cards/{skuId}": {
      get: {
        summary: "查询单个印刷 SKU 的目录详情",
        responses: { "200": { description: "SKU 详情" }, "404": { description: "SKU 不存在" } }
      }
    },
    "/v1/catalog/images/{imageName}": {
      get: {
        summary: "读取本地缓存卡图",
        responses: { "200": { description: "图片二进制" }, "404": { description: "图片不存在" } }
      }
    },
    "/v1/prices/status": {
      get: {
        summary: "查询玩家可见的外部价格来源与新鲜度",
        responses: { "200": { description: "公开价格状态" }, "401": { description: "认证无效或过期" } }
      }
    },
    "/v1/packs": {
      get: {
        summary: "公示补充包价格、启用状态和版本化卡位概率",
        responses: {
          "200": { description: "补充包列表" },
          "401": { description: "认证无效或过期" }
        }
      }
    },
    "/v1/packs/{packId}": {
      get: {
        summary: "查询单个补充包的服务端概率配置",
        responses: { "200": { description: "补充包详情" }, "404": { description: "补充包不存在" } }
      }
    },
    "/v1/store/packs": {
      get: {
        summary: "查询当前可购买的补充包",
        responses: {
          "200": { description: "活动补充包列表" },
          "401": { description: "认证无效或过期" }
        }
      }
    },
    "/v1/store/packs/{packId}/purchase-preview": {
      get: {
        summary: "获取补充包购买预览和当前规则版本",
        responses: {
          "200": { description: "购买预览" },
          "404": { description: "补充包不存在" },
          "409": { description: "补充包已下架" }
        }
      }
    },
    "/v1/packs/{packId}/open": {
      post: {
        summary: "幂等购买补充包并由服务端结算开包",
        responses: {
          "201": { description: "开包已结算" },
          "200": { description: "幂等重放" },
          "400": { description: "幂等键或请求参数无效" },
          "409": { description: "余额不足、版本过期、包不可用或幂等冲突" }
        }
      }
    },
    "/v1/pack-openings": {
      get: {
        summary: "分页查询当前玩家的开包历史",
        responses: {
          "200": { description: "开包记录分页" },
          "401": { description: "认证无效或过期" }
        }
      }
    },
    "/v1/admin/catalog/sync": {
      get: {
        summary: "查询 Scryfall 目录同步状态",
        responses: { "200": { description: "同步状态" } }
      },
      post: {
        summary: "投递去重的 Scryfall 目录同步任务",
        responses: {
          "201": { description: "任务已投递或返回活跃任务" },
          "400": { description: "缺少幂等键或参数无效" }
        }
      }
    },
    "/v1/admin/prices/sync": {
      get: { summary: "查询 MTGJSON Cardmarket 价格同步状态", responses: { "200": { description: "价格快照状态" }, "403": { description: "需要管理员权限" } } },
      post: { summary: "投递去重的 MTGJSON 价格同步任务，或在 checksum 失败后提交管理员覆写", responses: { "201": { description: "任务已投递或返回活跃任务" }, "400": { description: "缺少幂等键或参数无效" }, "403": { description: "需要管理员权限" }, "409": { description: "当前没有可覆写的 checksum 失败运行" } } }
    },
    "/v1/admin/prices/backfill": {
      get: { summary: "查询最近一次 AllPrices 历史价格回填运行结果", responses: { "200": { description: "回填结果" }, "403": { description: "需要管理员权限" } } },
      post: { summary: "投递一次性 AllPrices 历史价格回填任务，只补齐缺失日期", responses: { "201": { description: "任务已投递或返回活跃任务" }, "400": { description: "缺少幂等键或参数无效" }, "403": { description: "需要管理员权限" } } }
    },
    "/v1/admin/jobs": {
      get: { summary: "管理任务查询", responses: { "200": { description: "任务列表" } } },
      post: {
        summary: "投递管理任务",
        responses: {
          "201": { description: "任务已投递或去重返回" },
          "400": { description: "缺少幂等键或参数无效" }
        }
      }
    },
    "/v1/admin/jobs/{id}/retry": {
      post: {
        summary: "手动重试失败或死亡任务",
        responses: {
          "200": { description: "任务已重新排队" },
          "409": { description: "状态不可重试" }
        }
      }
    },
    "/v1/admin/dashboard": { get: { summary: "管理后台首页聚合", responses: { "200": { description: "环境、新鲜度、失败任务、活动与异常摘要" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/audit-logs": { get: { summary: "只读、服务端分页的审计日志查询", responses: { "200": { description: "脱敏审计日志分页" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/audit-logs/{id}": { get: { summary: "审计日志详情与关联记录", responses: { "200": { description: "脱敏日志详情" }, "404": { description: "日志不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/exception-trades": { get: { summary: "异常交易与失败任务待复核项", responses: { "200": { description: "异常项列表" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/campaigns": { get: { summary: "活动列表", responses: { "200": { description: "活动分页" }, "403": { description: "需要管理员权限" } } }, post: { summary: "保存活动草稿", responses: { "201": { description: "草稿已保存" }, "400": { description: "校验失败" }, "409": { description: "代码冲突" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/campaigns/{id}": { get: { summary: "活动详情", responses: { "200": { description: "活动" }, "404": { description: "活动不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/campaigns/{id}/preview": { post: { summary: "活动发布前服务端预览", responses: { "200": { description: "预览版本、冲突与预计任务" }, "404": { description: "活动不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/campaigns/{id}/publish": { post: { summary: "发布活动为不可变市场事件并投递重定价", responses: { "200": { description: "活动已发布" }, "409": { description: "版本冲突或定义冲突" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/campaigns/{id}/pause": { post: { summary: "暂停已发布活动", responses: { "200": { description: "活动已暂停" }, "409": { description: "状态不可暂停" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/campaigns/{id}/end": { post: { summary: "结束活动", responses: { "200": { description: "活动已结束" }, "409": { description: "状态不可结束" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/campaigns/{id}/schedule": { post: { summary: "定时发布活动，以 starts_at 投递重价任务", responses: { "200": { description: "已安排" }, "409": { description: "版本冲突" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/users": { get: { summary: "按 ID/用户名/角色/状态检索用户", responses: { "200": { description: "用户分页" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/users/{id}": { get: { summary: "用户管理详情", responses: { "200": { description: "脱敏用户详情" }, "404": { description: "用户不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/users/{id}/freeze": { post: { summary: "冻结用户", responses: { "200": { description: "已冻结" }, "404": { description: "用户不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/users/{id}/unfreeze": { post: { summary: "解冻用户", responses: { "200": { description: "已解冻" }, "404": { description: "用户不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/users/{id}/revoke-sessions": { post: { summary: "撤销用户会话", responses: { "200": { description: "已撤销" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/users/{id}/compensate/balance": { post: { summary: "余额补偿修正（追加账本，不覆盖原值）", responses: { "200": { description: "新流水与余额" }, "409": { description: "余额不足或冲突" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/users/{id}/compensate/inventory": { post: { summary: "库存补偿修正（追加库存流水，不覆盖原值）", responses: { "200": { description: "新流水与库存" }, "409": { description: "库存不足或冲突" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/market-parameters": { get: { summary: "读取市场参数单例", responses: { "200": { description: "市场参数" }, "404": { description: "未初始化" }, "403": { description: "需要管理员权限" } } }, post: { summary: "更新市场参数并投递重定价", responses: { "200": { description: "更新后参数" }, "409": { description: "版本冲突" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/catalog/series": { get: { summary: "系列列表与可交易 SKU 计数", responses: { "200": { description: "系列列表" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/catalog/skus/{id}/tradable": { post: { summary: "切换 SKU 可交易资格，不改目录或价格快照", responses: { "200": { description: "已切换" }, "404": { description: "SKU 不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/catalog/sync-trigger": { post: { summary: "投递目录同步任务（uniqueKey 去重）", responses: { "201": { description: "任务已投递" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/prices/sync-trigger": { post: { summary: "投递价格同步任务（uniqueKey 去重）", responses: { "201": { description: "任务已投递" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/mtgjson/setlist-draft": { post: { summary: "创建 MTGJSON SetList 导入草稿", responses: { "201": { description: "草稿已创建" }, "400": { description: "无有效条目" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/mtgjson/drafts": { get: { summary: "MTGJSON 导入草稿列表", responses: { "200": { description: "草稿分页" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/mtgjson/drafts/{id}": { get: { summary: "MTGJSON 导入草稿详情", responses: { "200": { description: "草稿" }, "404": { description: "草稿不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/mtgjson/drafts/{id}/preview": { post: { summary: "草稿映射预览（可导入/缺失/冲突）", responses: { "200": { description: "映射摘要" }, "404": { description: "草稿不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/mtgjson/drafts/{id}/discard": { post: { summary: "丢弃草稿", responses: { "200": { description: "已丢弃" }, "409": { description: "状态不允许丢弃" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/packs/{packId}/rule-preview": { post: { summary: "补充包规则发布前预览", responses: { "200": { description: "概率与校验结果" }, "404": { description: "补充包不存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/packs/{packId}/rule-publish": { post: { summary: "发布新版本补充包规则（不可原地覆盖）", responses: { "201": { description: "已发布" }, "409": { description: "版本已存在" }, "403": { description: "需要管理员权限" } } } },
    "/v1/admin/packs/{packId}/disable": { post: { summary: "停用补充包", responses: { "200": { description: "已停用" }, "409": { description: "已停用或不存在" }, "403": { description: "需要管理员权限" } } } }
  }
} as const;
