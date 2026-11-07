#!/bin/bash
# 双击启动会议录音处理服务（仅本机 127.0.0.1:8950）
cd "$(dirname "$0")"
exec .venv/bin/python server.py
