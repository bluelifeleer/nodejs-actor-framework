/** 数据目录的**唯一来源**：配置默认值、内核持久化、迁移与投影都从这里取。 */
export const DATA_DIR = process.env.APP_DATA_DIR ?? './data';
