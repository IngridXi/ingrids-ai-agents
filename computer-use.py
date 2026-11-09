#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 computer-use.py — 电脑操作员后端（local-first）
============================================================
 让一个视觉模型「看屏幕 → 决定动作 → 动鼠标键盘」，循环直到任务完成。

 组成：
   1. screenshot   : screencapture 截全屏 → sips 缩放到逻辑分辨率
   2. ask_vision   : 调本地 Ollama qwen2.5vl 视觉模型决策（输出 JSON 动作）
   3. execute      : Quartz CGEvent 执行鼠标点击 / 移动 / 键盘 / 滚轮
   4. loop         : 看 → 想 → 动 → 再看，最多 max-steps 步

 坐标约定：截图缩放到「逻辑分辨率」（Retina 2x 屏即 1512x982），
 模型输出的 x/y 就是 CGEvent 用的逻辑点坐标，无需换算。

 输出：stdout 每行一个 JSON（供 Electron 主进程流式转发）：
   {"type":"step","step":0,"thought":"...","action":{...},"img":"data:image/png;base64,..."}
   {"type":"done","summary":"..."} / {"type":"error","message":"..."}

 用法：
   python3 computer-use.py --task "打开浏览器搜索 XXX" --max-steps 15
   python3 computer-use.py --task "..." --dry-run   # 只看+想，不执行动作
============================================================
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

import Quartz
from AppKit import NSScreen

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen2.5vl:7b"

# 屏幕逻辑分辨率（从 NSScreen 动态取，Retina 2x 即物理/2）
def logical_size():
    try:
        f = NSScreen.screens()[0].frame()
        return int(f.size.width), int(f.size.height)
    except Exception:
        return 1512, 982

LOGICAL_W, LOGICAL_H = logical_size()

# 常用键 → macOS keycode
KEYCODES = {
    "return": 36, "enter": 36, "escape": 53, "esc": 53,
    "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "command": 55, "cmd": 55, "shift": 56, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59,
    "f5": 96, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
}


def emit(obj):
    """输出一行 JSON 到 stdout（Electron 主进程逐行读取）"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def screenshot():
    """截全屏并缩放到逻辑分辨率，返回 (base64, 原始物理路径已删除)"""
    import tempfile
    tmp = tempfile.mkdtemp(prefix="cu-shot-")
    raw = os.path.join(tmp, "raw.png")
    scaled = os.path.join(tmp, "scaled.png")
    try:
        r = subprocess.run(["screencapture", "-x", raw],
                           capture_output=True, timeout=15)
        if r.returncode != 0:
            raise RuntimeError(
                "无法截屏：请在「系统设置 → 隐私与安全性 → 屏幕录制」里，"
                "给 Ingrid's AI Agents（或终端）打勾授权，然后重试。"
                "（原始错误：" + (r.stderr.decode() or "could not create image").strip() + "）")
        # 缩放到逻辑分辨率，保证模型输出坐标可直接用于 CGEvent
        subprocess.run(["sips", "-z", str(LOGICAL_H), str(LOGICAL_W), raw,
                        "--out", scaled], check=True, capture_output=True, timeout=15)
        with open(scaled, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        return b64
    finally:
        subprocess.run(["rm", "-rf", tmp], capture_output=True)


def ask_vision(img_b64, task, step, history_text, retry_hint=None):
    """调 Ollama qwen2.5vl，返回模型文本"""
    prompt = (
        "你是一个电脑操作助手，正在替用户操作 macOS 电脑。\n"
        "当前任务：{task}\n"
        "屏幕逻辑分辨率：{w} x {h}，坐标原点在左上角，向右为 x 正、向下为 y 正。\n\n"
        "这是第 {step} 步。之前已做的步骤：{hist}\n\n"
        "请观察当前屏幕截图，决定【下一步】该做什么，只输出一个 JSON 对象，"
        "不要输出任何其他文字、不要用代码块包裹：\n"
        "{{\n"
        '  "thought": "你看到了什么、为什么这么做（简短一句话）",\n'
        '  "action": {{\n'
        '    "type": "click|double_click|right_click|type|key|scroll|move|done|wait",\n'
        '    "x": 整数, "y": 整数,\n'
        '    "text": "要输入的文字（type 时）",\n'
        '    "key": "return/escape/tab/...（key 时）",\n'
        '    "dy": 整数（scroll 时，负数向上滚、正数向下滚）\n'
        "  }}\n"
        "}}\n\n"
        "规则：\n"
        "- 任务已完成或已得到明确结果 → type 设为 \"done\"\n"
        "- 屏幕还没加载出来、或不确定时 → type 设为 \"wait\"\n"
        "- 点击要精准，选最明显、最像目标的位置\n"
        "- 坐标用整数\n"
    ).format(task=task, w=LOGICAL_W, h=LOGICAL_H, step=step,
             hist=history_text or "（无）")
    if retry_hint:
        prompt += "\n\n【重要 · 重试】" + retry_hint

    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt, "images": [img_b64]}],
        "stream": False,
        "options": {"temperature": 0.1},
    }
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (data.get("message") or {}).get("content") or ""


def parse_action(text):
    """从模型输出里提取 JSON 对象"""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _mouse_event(etype, x, y, button=Quartz.kCGMouseButtonLeft):
    ev = Quartz.CGEventCreateMouseEvent(None, etype, (x, y), button)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)


def _click(x, y, button=Quartz.kCGMouseButtonLeft, double=False):
    _mouse_event(Quartz.kCGEventMouseMoved, x, y, button)
    time.sleep(0.06)
    for _ in range(2 if double else 1):
        _mouse_event(Quartz.kCGEventLeftMouseDown, x, y, button)
        time.sleep(0.04)
        _mouse_event(Quartz.kCGEventLeftMouseUp, x, y, button)
        time.sleep(0.04)


def _type_text(text):
    # Unicode 输入（支持中文）
    down = Quartz.CGEventCreateKeyboardEvent(None, 0, True)
    Quartz.CGEventKeyboardSetUnicodeString(down, len(text), text)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    up = Quartz.CGEventCreateKeyboardEvent(None, 0, False)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)


def _key(keycode):
    down = Quartz.CGEventCreateKeyboardEvent(None, keycode, True)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    up = Quartz.CGEventCreateKeyboardEvent(None, keycode, False)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)


def _scroll(dy):
    ev = Quartz.CGEventCreateScrollWheelEvent(
        None, Quartz.kCGScrollEventUnitPixel, 1, int(dy))
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)


def execute(action, dry_run):
    """执行一个动作，返回 (ok, 描述)"""
    t = (action or {}).get("type")
    x = int(action.get("x", 0) or 0)
    y = int(action.get("y", 0) or 0)

    if t == "click":
        desc = "点击 (%d, %d)" % (x, y)
        if not dry_run:
            _click(x, y)
    elif t == "double_click":
        desc = "双击 (%d, %d)" % (x, y)
        if not dry_run:
            _click(x, y, double=True)
    elif t == "right_click":
        desc = "右键 (%d, %d)" % (x, y)
        if not dry_run:
            _click(x, y, button=Quartz.kCGMouseButtonRight)
    elif t == "type":
        text = str(action.get("text", ""))
        desc = "输入「%s」" % text
        if not dry_run:
            _type_text(text)
    elif t == "key":
        key = str(action.get("key", "")).lower()
        kc = KEYCODES.get(key)
        desc = "按键 " + key
        if kc and not dry_run:
            _key(kc)
        elif not kc:
            desc = "按键 " + key + "（未识别）"
    elif t == "scroll":
        dy = int(action.get("dy", 0) or 0)
        desc = "滚动 %d" % dy
        if not dry_run:
            _scroll(dy)
    elif t == "move":
        desc = "移动鼠标到 (%d, %d)" % (x, y)
        if not dry_run:
            _mouse_event(Quartz.kCGEventMouseMoved, x, y)
    elif t == "done":
        desc = "任务完成"
    elif t == "wait":
        desc = "等待"
        time.sleep(1.5)
    else:
        desc = "未知动作 " + str(t)
    return True, desc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--max-steps", type=int, default=15)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    task = args.task.strip()
    history = []
    # 连续失败重试上限：视觉模型偶发输出坏格式 / 截图偶发失败 / 超时，
    # 不应让整个任务「做一步就中断」；连续失败达到上限才停。
    MAX_CONSECUTIVE_FAILURES = 3
    step = 0
    failures = 0
    retry_hint = None
    try:
        while step < args.max_steps:
            try:
                img_b64 = screenshot()
                resp = ask_vision(img_b64, task, step,
                                  "；".join(history[-6:]), retry_hint)
                parsed = parse_action(resp)
                if not parsed:
                    # 输出坏格式：重试该步（带纠正提示），不中断整个任务
                    failures += 1
                    retry_hint = ("上次输出无法解析，请只输出一个 JSON 对象，"
                                  "不要任何多余文字、不要用代码块包裹。")
                    if failures >= MAX_CONSECUTIVE_FAILURES:
                        emit({"type": "error",
                              "message": "连续多次无法解析模型输出，已停止。原始：" + resp[:200]})
                        return
                    emit({"type": "step", "step": step,
                          "thought": "（模型输出异常，自动重试第 %d 次）" % failures,
                          "action": {"type": "wait"}, "desc": "重试"})
                    time.sleep(0.8)
                    continue
                failures = 0
                retry_hint = None
                thought = str(parsed.get("thought", ""))
                action = parsed.get("action") or {}
                ok, desc = execute(action, args.dry_run)

                emit({
                    "type": "step",
                    "step": step,
                    "thought": thought,
                    "action": action,
                    "desc": desc,
                    "img": "data:image/png;base64," + img_b64,
                })
                history.append("%d. %s → %s" % (step, thought, desc))

                if action.get("type") == "done":
                    emit({"type": "done", "summary": thought,
                          "steps": step + 1})
                    return
                step += 1
                time.sleep(0.5)
            except Exception as e:
                # 单步异常（截图偶发失败 / 网络 / 超时）：重试该步，不中断
                failures += 1
                if failures >= MAX_CONSECUTIVE_FAILURES:
                    emit({"type": "error", "message": str(e)})
                    return
                emit({"type": "step", "step": step,
                      "thought": "（本步出错，自动重试第 %d 次：%s）" % (failures, str(e)[:80]),
                      "action": {"type": "wait"}, "desc": "重试"})
                time.sleep(0.8)
        emit({"type": "done",
              "summary": "达到最大步数 %d，任务未明确结束" % args.max_steps,
              "steps": step})
    except Exception as e:
        emit({"type": "error", "message": str(e)})


if __name__ == "__main__":
    main()
