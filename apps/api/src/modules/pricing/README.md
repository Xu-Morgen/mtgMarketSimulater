# Pricing Module

拥有 MTGJSON 映射校验、外部价格快照、快照新鲜度和交易暂停状态。I13B 将 AllPrintings 的 Scryfall ID/MTGJSON UUID/工艺精确映射到目录 SKU，并只接受 Cardmarket EUR Trend retail 的正值；快照只追加，异常 SKU 不得新增交易，已有估值使用最后成功快照。
