// 管理台两张元数据表的列定义：服务端页面先查一次（SSR 初值），客户端管理器在改动后
// 用同样的列重查刷新，两边必须同形，所以收在一处。
//
// 为什么单独一个模块、而不是写在各自的组件文件里：组件是 "use client" 模块，
// 服务端组件从 client 模块 import 任何**值**拿到的都是 client reference 代理对象
// （不是字符串），`.select(代理)` 会在运行时炸成 "xxx.split is not a function"——
// Next 在构建期不报错，只有真进到页面才炸。常量放这里（无 "use client"），两边都拿真身。

// 学校带出所属市（0082）：city_id 是"改市"下拉的当前值，cities(name) 是列表里显示的名字。
// PostgREST 内嵌靠 schools.city_id → cities.id 这条外键，一对一、无歧义（不像
// questions↔question_versions 那两条 FK 要写 hint）。
export const SCHOOL_COLUMNS = "id, name, code, city_id, is_active, created_at, cities(name)"

// 市带出学校数（用于"停用这个市会影响几所学校"的提示）。同 TAG_COLUMNS 的计数口径。
export const CITY_COLUMNS = "id, name, code, is_active, created_at, schools(count)"

export const TAG_COLUMNS = "id, name, created_at, version_tags(count)"
