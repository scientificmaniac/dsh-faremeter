#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepSeek 一轮对话 API 费用 —— 独立 Python 参考实现与基准向量工具。

本文件是 JavaScript 插件实现的「独立第二实现」，仅使用 Python 标准库，
用来计算一轮对话的人民币（CNY）费用，并生成 / 校验 test/vectors.json。

计费规格（严格按任务说明实现）
==============================
- 价格单位：人民币元 / 百万 token；每个模型的每个 token 类别有「谷价、峰价」两档。
- 峰谷判定 is_peak(at)：先把时刻换算成北京时间（UTC+8，固定偏移、无夏令时），然后
    1) 北京日期是周六或周日            -> 谷价；
    2) 北京日期在中国法定节假日放假日集合中 -> 谷价；
    3) 否则按北京小时数 h：
         9 <= h < 12 或 14 <= h < 18   -> 峰价；
         其余                          -> 谷价。
  注意：调休上班的周末（例如 2026-10-10 周六）仍然按周末判为谷价。
- 费用公式（单位：元）：
      cost = cacheReadTokens/1e6 * hit
           + uncachedInputTokens/1e6 * miss
           + outputTokens/1e6 * out
  cacheWriteTokens 不参与计费（DeepSeek 不对缓存写入单独收费），但向量中会携带该字段，
  用来验证实现确实忽略它；reasoningTokens 视为已包含在 outputTokens 内，不另外加价。
- 金额使用双精度浮点表示，最终 quantize 到 1e-9（四舍五入）后再写入 JSON 数字。

用法
====
    python test/expected_cost.py            # 打印 vectors.json 中全部用例的判定与费用
    python test/expected_cost.py --check    # 自检：重算全部用例，与 vectors.json 的 expected 比对
    python test/expected_cost.py --write    # 按规格重算并回写 vectors.json 的 expected 字段
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量：时区、价格表、2026 年法定节假日放假日
# ---------------------------------------------------------------------------

# 北京时间固定为 UTC+8（中国自 1991 年起不实行夏令时），因此用固定偏移即可。
BEIJING_TZ = timezone(timedelta(hours=8))

# 价格表：单位「人民币元 / 百万 token」。
# 每个类别是二元组，顺序固定为 (谷价, 峰价)，即 [0] = 谷价、[1] = 峰价。
PRICES: dict[str, dict[str, tuple[Decimal, Decimal]]] = {
    "deepseek-flash": {
        "hit": (Decimal("0.02"), Decimal("0.04")),
        "miss": (Decimal("1.0"), Decimal("2.0")),
        "out": (Decimal("4.0"), Decimal("8.0")),
    },
    "deepseek-v4-pro": {
        "hit": (Decimal("0.15"), Decimal("0.30")),
        "miss": (Decimal("4.5"), Decimal("9.0")),
        "out": (Decimal("13.5"), Decimal("27.0")),
    },
}

MILLION = Decimal(1_000_000)
# 费用保留到 1e-9 精度；用 Decimal 精确算出后四舍五入，再转成 JSON 数字（双精度浮点）。
COST_QUANTUM = Decimal("1e-9")

# 向量里必须携带的四个 token 字段；多余字段（如 reasoningTokens）会被忽略。
USAGE_KEYS = (
    "uncachedInputTokens",
    "cacheReadTokens",
    "outputTokens",
    "cacheWriteTokens",
)


def _date_range(year: int, month: int, first_day: int, last_day: int) -> list[date]:
    """生成闭区间 [first_day, last_day] 内的全部日期。"""
    return [date(year, month, day) for day in range(first_day, last_day + 1)]


# 2026 年中国法定节假日「放假日」集合（只含放假日，不含调休上班日）。
# 数据来源：任务给定的价格/节假日表。
HOLIDAYS: frozenset[date] = frozenset(
    _date_range(2026, 1, 1, 3)       # 元旦：01-01 ~ 01-03
    + _date_range(2026, 2, 15, 23)   # 春节：02-15 ~ 02-23
    + _date_range(2026, 4, 4, 6)     # 清明：04-04 ~ 04-06
    + _date_range(2026, 5, 1, 5)     # 劳动节：05-01 ~ 05-05
    + _date_range(2026, 6, 19, 21)   # 端午：06-19 ~ 06-21
    + _date_range(2026, 9, 25, 27)   # 中秋：09-25 ~ 09-27
    + _date_range(2026, 10, 1, 7)    # 国庆：10-01 ~ 10-07
)


# ---------------------------------------------------------------------------
# 时刻解析与峰谷判定
# ---------------------------------------------------------------------------


def parse_at(text: str) -> datetime:
    """把 ISO 8601 时刻字符串解析为带时区的 datetime。

    要求字符串必须带明确的时区偏移（如 +08:00、-04:00、Z），
    未带偏移的「裸时间」会被拒绝，避免不同实现按本地时区猜测。
    """
    raw = text.strip()
    # 兼容老版本 Python 不认结尾的 "Z"：统一改写成 +00:00。
    if raw.endswith(("Z", "z")):
        raw = raw[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"无法解析时刻 {text!r}：{exc}") from exc
    if moment.tzinfo is None:
        raise ValueError(f"时刻 {text!r} 缺少时区偏移（例如 +08:00 或 Z）")
    return moment


def is_peak(moment: datetime) -> bool:
    """判断某一时刻是否属于峰价时段（输入必须是带时区的 datetime）。"""
    if moment.tzinfo is None:
        raise ValueError("is_peak 需要带时区的 datetime")
    # 一律换算到北京时间（UTC+8）后按日历判断。
    beijing = moment.astimezone(BEIJING_TZ)
    # 1) 周六、周日：谷价（调休上班的周末也按周末算谷价）。
    if beijing.weekday() >= 5:  # Python: 周一=0 ... 周六=5、周日=6
        return False
    # 2) 法定节假日放假日：谷价。
    if beijing.date() in HOLIDAYS:
        return False
    # 3) 工作日按北京时间小时数划分峰谷。
    hour = beijing.hour
    return 9 <= hour < 12 or 14 <= hour < 18


# ---------------------------------------------------------------------------
# 用量校验与费用计算
# ---------------------------------------------------------------------------


def normalize_usage(raw_usage: object) -> dict[str, int]:
    """校验并规范化 usage 对象，返回四个 token 字段的整数字典。"""
    if not isinstance(raw_usage, dict):
        raise ValueError(f"usage 必须是对象，实际为 {type(raw_usage).__name__}")
    usage: dict[str, int] = {}
    for key in USAGE_KEYS:
        if key not in raw_usage:
            raise ValueError(f"usage 缺少字段 {key!r}")
        value = raw_usage[key]
        # bool 是 int 的子类，这里要单独排除，避免 True/False 被当成 1/0 混进来。
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"usage.{key} 必须是整数，实际为 {value!r}")
        if value < 0:
            raise ValueError(f"usage.{key} 不能为负数，实际为 {value}")
        usage[key] = value
    # cacheWriteTokens 保留在 usage 里，但不参与计费。
    return usage


def price_of(model: str, category: str, peak: bool) -> Decimal:
    """取某模型某类别在峰 / 谷时段的价格（元 / 百万 token）。"""
    model_prices = PRICES.get(model)
    if model_prices is None:
        raise ValueError(f"未知模型 {model!r}，可选：{', '.join(PRICES)}")
    off_peak_price, peak_price = model_prices[category]
    return peak_price if peak else off_peak_price


def compute_cost(model: str, usage: dict[str, int], peak: bool) -> float:
    """按规格计算一轮对话的费用（元），返回保留到 1e-9 精度的双精度浮点。

    注意：cacheWriteTokens 明确不计费；reasoningTokens 已包含在 outputTokens 内，不另加。
    """
    hit_price = price_of(model, "hit", peak)
    miss_price = price_of(model, "miss", peak)
    out_price = price_of(model, "out", peak)

    total = (
        Decimal(usage["cacheReadTokens"]) * hit_price
        + Decimal(usage["uncachedInputTokens"]) * miss_price
        + Decimal(usage["outputTokens"]) * out_price
    ) / MILLION

    # 四舍五入到 1e-9，再转成双精度浮点，保证写进 JSON 的是 1e-9 精度的数字。
    return float(total.quantize(COST_QUANTUM, rounding=ROUND_HALF_UP))


def evaluate_case(case: dict) -> tuple[bool, float]:
    """按用例的 at / model / usage 计算 (是否峰价, 费用)。"""
    at = parse_at(str(case["at"]))
    peak = is_peak(at)
    usage = normalize_usage(case["usage"])
    cost = compute_cost(str(case["model"]), usage, peak)
    return peak, cost


# ---------------------------------------------------------------------------
# 命令行子命令
# ---------------------------------------------------------------------------


def load_vectors(path: Path) -> list[dict]:
    """读取 vectors.json，要求顶层是数组。"""
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise ValueError("vectors.json 顶层必须是数组")
    return data


def _peak_label(peak: bool) -> str:
    return "峰" if peak else "谷"


def cmd_print(cases: list[dict]) -> int:
    """默认模式：打印全部用例的判定与费用。"""
    print(f"独立 Python 参考实现 —— 共 {len(cases)} 个用例")
    for index, case in enumerate(cases, 1):
        name = case.get("name", f"#{index}")
        peak, cost = evaluate_case(case)
        usage = normalize_usage(case["usage"])
        print(
            f"{index:>3}. {name} | at={case['at']} | model={case['model']} | "
            f"峰谷={_peak_label(peak)}"
        )
        print(
            f"     cacheRead={usage['cacheReadTokens']} "
            f"uncachedInput={usage['uncachedInputTokens']} "
            f"output={usage['outputTokens']} "
            f"cacheWrite={usage['cacheWriteTokens']}（不计费）"
        )
        print(f"     cost = {cost:.9f} CNY")
    print(f"\n共 {len(cases)} 个用例。")
    return 0


def cmd_check(cases: list[dict]) -> int:
    """自检模式：重算全部用例，与 vectors.json 中的 expected 严格比对。"""
    failures = 0
    for index, case in enumerate(cases, 1):
        name = case.get("name", f"#{index}")
        try:
            peak, cost = evaluate_case(case)
        except (KeyError, TypeError, ValueError) as exc:
            print(f"[FAIL] {index}. {name}：无法计算：{exc}")
            failures += 1
            continue

        expected = case.get("expected")
        problems: list[str] = []
        if not isinstance(expected, dict):
            problems.append("缺少 expected 对象")
        else:
            expected_peak = expected.get("peak")
            if not isinstance(expected_peak, bool):
                problems.append(f"expected.peak 不是布尔值：{expected_peak!r}")
            elif expected_peak != peak:
                problems.append(
                    f"peak 不一致：expected={expected_peak} 实际={peak}"
                )

            if expected.get("currency") != "CNY":
                problems.append(
                    f"expected.currency 应为 'CNY'，实际 {expected.get('currency')!r}"
                )

            expected_cost = expected.get("cost")
            if isinstance(expected_cost, bool) or not isinstance(
                expected_cost, (int, float)
            ):
                problems.append(f"expected.cost 不是数字：{expected_cost!r}")
            else:
                diff = abs(float(expected_cost) - cost)
                if diff > 0.0:
                    problems.append(
                        f"cost 不一致：expected={float(expected_cost)!r} "
                        f"实际={cost!r} 差={diff:g}"
                    )

        if problems:
            failures += 1
            print(f"[FAIL] {index}. {name}：" + "；".join(problems))

    total = len(cases)
    if failures:
        print(f"\n自检失败：{failures}/{total} 个用例与 expected 不一致。")
        return 1
    print(
        f"\n自检通过：{total}/{total} 个用例的 peak 与 cost 均与 vectors.json 的 "
        f"expected 完全一致（cost 已保留到 1e-9 精度）。"
    )
    return 0


def cmd_write(path: Path, cases: list[dict]) -> int:
    """回写模式：按规格重算并写回每个用例的 expected 字段。"""
    for case in cases:
        peak, cost = evaluate_case(case)
        # 保持字段顺序：name、at、model、usage、expected。
        case["expected"] = {"peak": peak, "cost": cost, "currency": "CNY"}
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(cases, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"已按规格重算并回写 {len(cases)} 个用例的 expected 到：{path}")
    return 0


def _force_utf8_stdout() -> None:
    """Windows 控制台/管道默认可能是 GBK，这里统一改成 UTF-8，避免中文乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdout()
    parser = argparse.ArgumentParser(
        description="DeepSeek 一轮对话 API 费用独立参考实现 / 基准向量工具"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--check",
        action="store_true",
        help="重算全部用例，并与 vectors.json 里的 expected 比对（自检）",
    )
    group.add_argument(
        "--write",
        action="store_true",
        help="按规格重算并回写 vectors.json 里的 expected 字段",
    )
    args = parser.parse_args(argv)

    vectors_path = Path(__file__).resolve().with_name("vectors.json")
    if not vectors_path.is_file():
        print(f"错误：找不到向量文件 {vectors_path}", file=sys.stderr)
        return 2
    try:
        cases = load_vectors(vectors_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"错误：读取 {vectors_path} 失败：{exc}", file=sys.stderr)
        return 2

    if args.check:
        return cmd_check(cases)
    if args.write:
        return cmd_write(vectors_path, cases)
    return cmd_print(cases)


if __name__ == "__main__":
    raise SystemExit(main())
