#!/usr/bin/env swift
// pdf_extract.swift — 用 macOS 自带 PDFKit 提取 PDF 全文，供工作台 fs_read 读取「原文」。
// 纯系统能力（PDFKit 框架 + /usr/bin/swift），不依赖任何第三方 Python/npm 包，保证工作台独立工作。
// 用法：swift pdf_extract.swift "/path/to/file.pdf"
// 输出：单行 JSON  { ok:true, content:"...", pages:N } 或 { ok:false, error:"..." }

import Foundation
import PDFKit

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"ok\":false,\"error\":\"输出序列化失败\"}")
    }
}

guard CommandLine.arguments.count >= 2 else {
    emit(["ok": false, "error": "缺少 PDF 路径参数"])
    exit(1)
}
let path = CommandLine.arguments[1]

guard FileManager.default.fileExists(atPath: path) else {
    emit(["ok": false, "error": "文件不存在：\(path)"])
    exit(1)
}

guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
    emit(["ok": false, "error": "无法打开 PDF（可能已损坏或不是有效 PDF）"])
    exit(1)
}

if doc.isLocked {
    emit(["ok": false, "error": "PDF 已加密，需要密码才能读取"])
    exit(1)
}

let pageCount = doc.pageCount
var parts: [String] = []
for i in 0..<pageCount {
    if let page = doc.page(at: i) {
        parts.append(page.string ?? "")
    }
}
let full = parts.joined(separator: "\n\n")
let trimmed = full.trimmingCharacters(in: .whitespacesAndNewlines)

if trimmed.isEmpty {
    emit(["ok": false, "error": "未提取到文本：该 PDF 可能是扫描版/图片型，无文字层。可先用 OCR 或直接粘贴截图给工作台识别。"])
    exit(1)
}

emit(["ok": true, "content": trimmed, "pages": pageCount])
