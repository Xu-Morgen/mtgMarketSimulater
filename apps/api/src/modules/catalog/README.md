# Catalog Module

拥有系列、印刷版本、`nonfoil`/`foil`/`etched` SKU、合法性和本地图像缓存元数据。I08B 的读取路径只访问本地 SQLite；目录仅能由 I09 同步任务或可审计的管理员例外更新，`manual-test` 例外不得伪装为外部参考价格资料。
