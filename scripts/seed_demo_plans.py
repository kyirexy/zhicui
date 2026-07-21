"""为本地开发账号写入宣传片所需的计划工作台演示数据。

脚本使用固定 ID 幂等更新，不会删除用户自己创建的计划。所有排期都以
运行当天的北京时间为基准，方便计划概览稳定展示今日、逾期和后续任务。
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.core.database import SessionLocal  # noqa: E402
from app.models.note import Note  # noqa: E402,F401 - 注册 plans.note_id 外键
from app.models.plan import Plan  # noqa: E402
from app.models.user import User  # noqa: E402

TZ = ZoneInfo("Asia/Shanghai")
TODAY = datetime.now(TZ).date()
NOW = datetime.now(timezone.utc)


def scheduled(day_offset: int, clock: str) -> str:
    return f"{(TODAY + timedelta(days=day_offset)).isoformat()}T{clock}"


def detail(label: str, value: Any) -> dict[str, Any]:
    return {"label": label, "value": value}


def task(
    task_id: str,
    title: str,
    day: int,
    when: str | None = None,
    *,
    done: bool = False,
    duration: int | None = None,
    frequency: str | None = None,
    priority: str = "medium",
    details: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": task_id,
        "title": title,
        "day": day,
        "done": done,
        "priority": priority,
    }
    if when:
        item["scheduled_at"] = when
    if duration:
        item["duration_minutes"] = duration
    if frequency:
        item["frequency"] = frequency
    if details:
        item["details"] = details
    return item


def field(
    name: str,
    label: str,
    field_type: str,
    value: Any,
    group: str,
) -> dict[str, Any]:
    return {
        "name": name,
        "label": label,
        "type": field_type,
        "value": value,
        "group": group,
    }


def build_days(
    tasks: list[dict[str, Any]],
    labels: dict[int, tuple[str, str, str]],
) -> list[dict[str, Any]]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for item in tasks:
        grouped[int(item["day"])].append(dict(item))

    days: list[dict[str, Any]] = []
    for day_number in sorted(grouped):
        label, date_value, focus = labels.get(
            day_number,
            (f"第 {day_number} 天", "", "按计划推进"),
        )
        day: dict[str, Any] = {
            "day": day_number,
            "label": label,
            "focus": focus,
            "tasks": grouped[day_number],
        }
        if date_value:
            day["date"] = date_value
        days.append(day)
    return days


def day_date(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


def plan_specs() -> list[dict[str, Any]]:
    english_tasks = [
        task(
            "demo-english-01",
            "录制 60 秒英文自我介绍基线",
            1,
            scheduled(0, "07:40"),
            duration=10,
            priority="high",
            details=[
                detail("要求", "不看稿，完整说完"),
                detail("记录", "卡顿次数与常用词"),
            ],
        ),
        task(
            "demo-english-02",
            "跟读一段 90 秒播客并做影子练习",
            1,
            scheduled(0, "20:30"),
            duration=20,
            frequency="每天 1 次",
            details=[detail("轮次", "听 2 遍、跟读 3 遍、脱稿 1 遍")],
        ),
        task(
            "demo-english-03",
            "整理 10 个高频表达并各造 1 句",
            2,
            scheduled(1, "20:30"),
            duration=25,
            frequency="每两天 10 个",
        ),
        task(
            "demo-english-04",
            "完成一次 5 分钟情景对话",
            7,
            scheduled(6, "21:00"),
            duration=15,
            frequency="每周 1 次",
            priority="high",
        ),
        task(
            "demo-english-05",
            "第 21 天重新录制并对比流利度",
            21,
            scheduled(20, "08:00"),
            duration=20,
            priority="high",
        ),
    ]

    beef_tasks = [
        task(
            "demo-beef-01",
            "牛腩切块、冷水浸泡并焯水",
            1,
            scheduled(0, "10:00"),
            duration=35,
            details=[
                detail("牛腩", "800g，切 4cm 块"),
                detail("去腥", "冷水下锅，撇净浮沫"),
            ],
        ),
        task(
            "demo-beef-02",
            "炒香洋葱与番茄，建立汤底",
            1,
            scheduled(0, "10:40"),
            duration=20,
            details=[
                detail("番茄", "一半炒化，一半后放"),
                detail("提示", "少量盐帮助出汁"),
            ],
        ),
        task(
            "demo-beef-03",
            "小火炖煮并检查软烂度",
            1,
            scheduled(0, "11:05"),
            duration=90,
            frequency="每 30 分钟检查 1 次",
            priority="high",
            details=[
                detail("液面", "刚好没过牛腩"),
                detail("完成标准", "筷子可轻松穿透"),
            ],
        ),
        task(
            "demo-beef-04",
            "收汁、补番茄块并调整酸甜咸",
            1,
            scheduled(0, "12:35"),
            duration=15,
            priority="high",
        ),
        task(
            "demo-beef-05",
            "第二天复热并记录风味变化",
            2,
            scheduled(1, "12:00"),
            duration=15,
            frequency="复热 1 次",
        ),
    ]

    cooking_tasks = [
        task(
            "demo-cook-01",
            "整理基础调味料与常用刀具",
            1,
            scheduled(0, "17:40"),
            done=True,
            duration=15,
            details=[
                detail("调味", "盐、生抽、醋、糖、淀粉"),
                detail("工具", "主厨刀、砧板、炒锅"),
            ],
        ),
        task(
            "demo-cook-02",
            "练习土豆丝粗细一致与泡水去淀粉",
            1,
            scheduled(0, "18:00"),
            duration=25,
            frequency="练习 2 次",
            priority="high",
            details=[
                detail("成品", "酸辣土豆丝"),
                detail("火候", "大火 90 秒"),
            ],
        ),
        task(
            "demo-cook-03",
            "番茄炒蛋：测试先蛋后番茄的出汁比例",
            2,
            scheduled(1, "18:20"),
            duration=30,
            details=[
                detail("比例", "3 个蛋 / 2 个番茄"),
                detail("关键", "蛋液七成熟先盛出"),
            ],
        ),
        task(
            "demo-cook-04",
            "宫保鸡丁：完成滑炒与碗汁预调",
            4,
            scheduled(3, "18:30"),
            duration=45,
            priority="high",
            details=[
                detail("鸡丁腌制", "15 分钟"),
                detail("碗汁", "生抽 2、醋 2、糖 1"),
            ],
        ),
        task(
            "demo-cook-05",
            "设计三菜一汤并在 60 分钟内完成",
            7,
            scheduled(6, "17:30"),
            duration=60,
            frequency="结课挑战",
            priority="high",
        ),
    ]

    running_tasks = [
        task(
            "demo-run-01",
            "完成 5 分钟快走热身",
            1,
            scheduled(-1, "18:50"),
            duration=5,
            priority="high",
            details=[detail("提醒", "肩颈放松，脚步轻")],
        ),
        task(
            "demo-run-02",
            "跑 1 分钟 / 走 2 分钟 × 6 轮",
            1,
            scheduled(0, "19:00"),
            duration=28,
            frequency="本周 3 次",
            priority="high",
            details=[
                detail("心率", "保持能完整说话"),
                detail("里程", "约 3 公里"),
            ],
        ),
        task(
            "demo-run-03",
            "小腿与髋屈肌拉伸",
            1,
            scheduled(0, "19:35"),
            duration=10,
            frequency="每次跑后",
        ),
        task(
            "demo-run-04",
            "轻松跑走训练：2 分钟跑 / 2 分钟走",
            4,
            scheduled(3, "07:10"),
            duration=32,
            frequency="本周第 2 次",
        ),
        task(
            "demo-run-05",
            "周末 40 分钟耐力走跑",
            7,
            scheduled(6, "08:30"),
            duration=40,
            frequency="每周 1 次",
            priority="high",
        ),
    ]

    strength_tasks = [
        task(
            "demo-strength-01",
            "完成体态与围度基线记录",
            1,
            scheduled(0, "07:30"),
            done=True,
            duration=20,
            priority="high",
            details=[
                detail("记录", "体重、腰围、正侧面照片"),
                detail("标准", "同一光线与站姿"),
            ],
        ),
        task(
            "demo-strength-02",
            "下肢力量：深蹲与罗马尼亚硬拉",
            1,
            scheduled(0, "19:30"),
            duration=55,
            frequency="每周 2 次",
            priority="high",
            details=[
                detail("组数", "深蹲 4×8；硬拉 4×10"),
                detail("强度", "RPE 7"),
            ],
        ),
        task(
            "demo-strength-03",
            "训练后蛋白质与睡眠复盘",
            1,
            scheduled(0, "21:10"),
            duration=10,
            frequency="每次训练后",
            details=[detail("目标", "蛋白质 30g，睡眠 ≥ 7.5 小时")],
        ),
        task(
            "demo-strength-04",
            "上肢推拉与肩胛稳定训练",
            3,
            scheduled(2, "19:30"),
            duration=50,
            frequency="每周 2 次",
            details=[
                detail("动作", "俯卧撑、划船、面拉"),
                detail("完成标准", "动作全程稳定无代偿"),
            ],
        ),
        task(
            "demo-strength-05",
            "第 1 周恢复性拉伸与步数检查",
            7,
            scheduled(6, "20:30"),
            duration=25,
            frequency="每周复盘",
            priority="low",
        ),
        task(
            "demo-strength-06",
            "第 4 周负重与围度复测",
            28,
            scheduled(27, "08:00"),
            duration=30,
            frequency="每 4 周 1 次",
            priority="high",
        ),
    ]

    return [
        {
            "id": "demo-plan-english",
            "title": "21 天英语口语表达训练",
            "total_days": 21,
            "tasks": english_tasks,
            "fields": [
                field("goal", "21 天目标", "text", "能自然完成 3 分钟日常主题表达", "目标"),
                field("daily_time", "每日投入", "duration", "20–30 分钟", "训练节奏"),
                field("frequency", "练习频率", "frequency", "跟读每天 1 次；对话每周 1 次", "训练节奏"),
                field("topics", "主题库", "list", ["自我介绍", "工作与学习", "兴趣爱好", "旅行计划", "观点表达"], "内容"),
                field(
                    "metrics",
                    "验收指标",
                    "text",
                    {"连续表达": "≥ 3 分钟", "明显卡顿": "≤ 3 次", "高频表达": "掌握 80 个"},
                    "验收",
                ),
            ],
            "days": build_days(
                english_tasks,
                {
                    1: ("基线与第一次跟读", day_date(0), "留下起点，建立可比较的声音样本"),
                    2: ("高频表达积累", day_date(1), "把表达放进自己的真实句子"),
                    7: ("第一周口语实战", day_date(6), "从跟读转向真实对话"),
                    21: ("结课复测", day_date(20), "用相同主题对比流利度变化"),
                },
            ),
        },
        {
            "id": "demo-plan-beef-stew",
            "title": "番茄牛腩：从备料到收汁",
            "total_days": 2,
            "tasks": beef_tasks,
            "fields": [
                field("servings", "份量", "metric", 4, "配方"),
                field("total_time", "总耗时", "duration", "约 2 小时 50 分钟", "配方"),
                field("ingredients", "核心食材", "list", ["牛腩 800g", "番茄 5 个", "洋葱 1 个", "姜 5 片", "香叶 2 片"], "食材"),
                field("pitfalls", "避坑重点", "checklist", ["牛腩不要切太小", "焯水后用温水冲洗", "盐分两次加入", "番茄分两批下锅"], "关键技巧"),
                field("taste", "成品目标", "quote", "汤汁浓而不腻，牛腩软烂但仍有完整纤维。", "验收"),
            ],
            "days": build_days(
                beef_tasks,
                {
                    1: ("主厨日 · 完整炖煮", day_date(0), "按时间节点完成一锅番茄牛腩"),
                    2: ("复热与复盘", day_date(1), "比较隔夜风味并记录调整点"),
                },
            ),
        },
        {
            "id": "demo-plan-home-cooking",
            "title": "7 天家常菜基本功进阶课",
            "total_days": 7,
            "tasks": cooking_tasks,
            "fields": [
                field("goal", "课程目标", "text", "7 天掌握刀工、火候、调味与同时出菜", "课程"),
                field("difficulty", "难度", "text", "零基础友好", "课程"),
                field("recipes", "练习菜单", "list", ["酸辣土豆丝", "番茄炒蛋", "宫保鸡丁", "菌菇豆腐汤"], "菜单"),
                field("shopping", "本周采购", "checklist", ["鸡胸肉 500g", "番茄 6 个", "土豆 3 个", "嫩豆腐 2 盒", "青红椒各 2 个"], "准备"),
                field("success", "完成标准", "text", "能独立安排顺序，让热菜同时上桌", "验收"),
            ],
            "days": build_days(
                cooking_tasks,
                {
                    1: ("第 1 课 · 刀工与脆炒", day_date(0), "先建立安全、稳定的切配动作"),
                    2: ("第 2 课 · 蛋类与出汁", day_date(1), "理解锅温与回锅时机"),
                    4: ("第 4 课 · 滑炒与复合味", day_date(3), "第一次练习碗汁和快速翻炒"),
                    7: ("结课 · 三菜一汤", day_date(6), "从备菜到同时出锅的完整演练"),
                },
            ),
        },
        {
            "id": "demo-plan-running",
            "title": "30 天零基础 5 公里跑步计划",
            "total_days": 30,
            "tasks": running_tasks,
            "fields": [
                field("goal", "30 天目标", "text", "无伤完成连续 5 公里慢跑", "目标"),
                field("current_level", "当前基础", "text", "可连续快走 30 分钟，暂无跑步习惯", "目标"),
                field("weekly_sessions", "每周次数", "metric", 3, "训练参数"),
                field("intensity", "强度控制", "text", {"主观强度": "RPE 4–6", "呼吸标准": "可以说完整句子"}, "训练参数"),
                field("checkpoints", "阶段节点", "checklist", ["第 7 天：连续慢跑 5 分钟", "第 14 天：完成 3 公里", "第 30 天：挑战 5 公里"], "阶段节点"),
            ],
            "days": build_days(
                running_tasks,
                {
                    1: ("第一次跑走训练", day_date(0), "慢下来，先建立呼吸和步频"),
                    4: ("第二次适应训练", day_date(3), "逐步延长跑步区间"),
                    7: ("周末耐力课", day_date(6), "完成本周最长时间"),
                },
            ),
        },
        {
            "id": "demo-plan-strength",
            "title": "12 周增肌与体态改善计划",
            "total_days": 84,
            "tasks": strength_tasks,
            "fields": [
                field("goal", "核心目标", "text", "12 周提升基础力量，改善圆肩与久坐体态", "目标与节奏"),
                field("frequency", "训练频率", "frequency", "每周 4 练 + 2 次低强度恢复", "目标与节奏"),
                field("duration", "单次时长", "duration", "45–60 分钟", "目标与节奏"),
                field("metrics", "追踪指标", "list", ["深蹲训练重量", "腰围变化", "睡眠时长", "每周完成率"], "身体指标"),
                field("nutrition", "营养原则", "checklist", ["每日蛋白质 1.6g/kg", "训练日前后补充主食", "每天饮水 2L 以上"], "恢复与营养"),
                field("hero_quote", "训练提醒", "quote", "稳定完成，比偶尔拼命更重要。", "恢复与营养"),
            ],
            "days": build_days(
                strength_tasks,
                {
                    1: ("启动日 · 建立基线", day_date(0), "记录数据并完成第一次下肢训练"),
                    3: ("上肢力量日", day_date(2), "推、拉与肩胛稳定"),
                    7: ("第一周复盘", day_date(6), "恢复、步数与完成率"),
                    28: ("阶段复测", day_date(27), "根据数据调整下一阶段负重"),
                },
            ),
        },
    ]


def main() -> None:
    specs = plan_specs()
    with SessionLocal() as db:
        user = db.query(User).filter(User.username == "zhicui_dev").first()
        if not user:
            raise SystemExit("未找到本地开发账号，请先调用 /api/auth/dev-session")

        for index, spec in enumerate(specs):
            plan = db.query(Plan).filter(Plan.id == spec["id"]).first()
            if not plan:
                plan = Plan(
                    id=spec["id"],
                    user_id=user.id,
                    note_id=None,
                )
                db.add(plan)

            plan.title = spec["title"]
            plan.user_id = user.id
            plan.schema_version = 2
            plan.total_days = spec["total_days"]
            plan.fields = json.dumps(spec["fields"], ensure_ascii=False)
            plan.tasks = json.dumps(spec["tasks"], ensure_ascii=False)
            plan.days_json = json.dumps(spec["days"], ensure_ascii=False)
            plan.status = "active"
            plan.created_at = NOW - timedelta(minutes=len(specs) - index)
            plan.updated_at = NOW

        db.commit()

        saved = (
            db.query(Plan)
            .filter(Plan.user_id == user.id)
            .order_by(Plan.created_at.desc())
            .all()
        )
        summary = [
            {
                "id": plan.id,
                "title": plan.title,
                "fields": len(plan.to_dict()["fields"]),
                "tasks": len(plan.to_dict()["tasks"]),
                "days": len(plan.to_dict()["days"]),
            }
            for plan in saved
        ]
        print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
