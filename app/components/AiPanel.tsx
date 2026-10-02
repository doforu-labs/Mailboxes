// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState, useRef, useEffect } from "react";
import { useParams } from "react-router";
import { Button } from "@cloudflare/kumo";
import {
	Sparkles,
	X,
	Send,
	Trash2,
} from "lucide-react";
import { useUIStore } from "~/hooks/useUIStore";

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	created_at: string;
}

export default function AiPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { isAiPanelOpen, toggleAiPanel, selectedEmailId } = useUIStore();
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [initialLoading, setInitialLoading] = useState(true);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Load chat history on open
	useEffect(() => {
		if (isAiPanelOpen && mailboxId) {
			setInitialLoading(true);
			fetch(`/api/v1/mailboxes/${mailboxId}/ai/chat?limit=20`)
				.then((r) => r.json())
				.then((data) => {
					setMessages(data.messages || []);
					setInitialLoading(false);
				})
				.catch(() => setInitialLoading(false));

			// Focus input when panel opens
			setTimeout(() => inputRef.current?.focus(), 100);
		}
	}, [isAiPanelOpen, mailboxId]);

	// Auto scroll to bottom
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	const sendMessage = async () => {
		const msg = input.trim();
		if (!msg || !mailboxId) return;
		setInput("");
		setLoading(true);

		// Optimistic: show user message immediately
		const streamId = "stream-" + Date.now();
		setMessages((prev) => [
			...prev,
			{ id: "opt-" + Date.now(), role: "user", content: msg, created_at: new Date().toISOString() },
			{ id: streamId, role: "assistant", content: "", created_at: new Date().toISOString() },
		]);

		try {
			const res = await fetch(`/api/v1/mailboxes/${mailboxId}/ai/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
				body: JSON.stringify({ message: msg, ...(selectedEmailId ? { emailContext: { emailId: selectedEmailId } } : {}) }),
			});

			if (!res.ok) throw new Error("API error");

			const reader = res.body?.getReader();
			if (!reader) throw new Error("No stream");

			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					try {
						const data = JSON.parse(line.slice(6));
						if (data.token) {
							// Append token to streaming message
							setMessages((prev) =>
								prev.map((m) =>
									m.id === streamId
										? { ...m, content: m.content + data.token }
										: m,
								),
							);
						}
						if (data.type === "tool_call") {
							// AI is calling a tool, show non-intrusive indicator
							setMessages((prev) =>
								prev.map((m) =>
									m.id === streamId
										? { ...m, content: m.content + "🔍 " }
										: m,
								),
							);
						}
						if (data.done) {
							// 只更新流式消息的 ID，不替换全部消息
							setMessages((prev) =>
								prev.map((m) =>
									m.id === streamId
										? { ...m, id: data.id || m.id }
										: m,
								),
							);
						}
						if (data.error) {
							setMessages((prev) =>
								prev.map((m) =>
									m.id === streamId
										? { ...m, content: "Error: " + data.error }
										: m,
								),
							);
						}
					} catch { /* skip malformed JSON */ }
				}
			}


		} catch {
			setMessages((prev) =>
				prev.map((m) =>
					m.id === streamId
						? { ...m, content: "Sorry, something went wrong. Please try again." }
						: m,
				),
			);
		}
		setLoading(false);
	};

	const clearChat = async () => {
		if (!mailboxId || loading) return;
		await fetch(`/api/v1/mailboxes/${mailboxId}/ai/chat`, {
			method: "DELETE",
		});
		setMessages([]);
	};

	if (!isAiPanelOpen) return null;

	return (
		<div className="w-80 border-l border-kumo-line bg-kumo-base flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2.5 border-b border-kumo-line">
				<div className="flex items-center gap-2">
					<Sparkles size={18} className="text-kumo-brand" />
					<span className="font-medium text-sm">AI Assistant</span>
				</div>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<Trash2 size={16} />}
						onClick={clearChat}
						aria-label="Clear chat"
					/>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<X size={16} />}
						onClick={toggleAiPanel}
						aria-label="Close AI panel"
					/>
				</div>
			</div>

			{/* Messages */}
			<div className="flex-1 overflow-y-auto p-3 space-y-3">
				{initialLoading ? (
					<div className="flex items-center justify-center h-full text-kumo-subtle text-sm">
						Loading...
					</div>
				) : messages.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full text-kumo-subtle text-sm gap-2">
						<Sparkles size={32} className="opacity-50" />
						<p>Search your inbox, draft replies, manage folders</p>
						<p className="text-xs opacity-70">
							e.g. "Find the latest invoice from Stripe"
						</p>
					</div>
				) : (
					messages.map((msg) => (
						<div
							key={msg.id}
							className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
						>
							<div
								className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
									msg.role === "user"
										? "bg-kumo-brand text-white"
										: "bg-kumo-tint text-kumo-default"
								}`}
							>
								{msg.role === "assistant" && !msg.content ? (
									<div className="flex items-center gap-1.5 py-0.5">
										<span className="w-1.5 h-1.5 bg-kumo-subtle rounded-full animate-pulse" />
										<span className="w-1.5 h-1.5 bg-kumo-subtle rounded-full animate-pulse" style={{ animationDelay: "0.2s" }} />
										<span className="w-1.5 h-1.5 bg-kumo-subtle rounded-full animate-pulse" style={{ animationDelay: "0.4s" }} />
									</div>
								) : (
									<p className="whitespace-pre-wrap">
										{msg.content}
									</p>
								)}
							</div>
						</div>
					))
				)}
				<div ref={messagesEndRef} />
			</div>

			{/* Input */}
			<div className="p-3 border-t border-kumo-line">
				<div className="flex gap-2">
					<input
						ref={inputRef}
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) =>
							e.key === "Enter" && !loading && sendMessage()
						}
						placeholder="Search, draft, manage your inbox..."
						disabled={loading}
						className="flex-1 px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-control focus:outline-none focus:ring-2 focus:ring-kumo-brand disabled:opacity-50"
					/>
					<Button
						variant="primary"
						shape="square"
						size="sm"
						icon={
							loading ? (
								<span className="animate-spin">⟳</span>
							) : (
								<Send size={16} />
							)
						}
						onClick={sendMessage}
						disabled={loading || !input.trim()}
						aria-label="Send"
					/>
				</div>
			</div>
		</div>
	);
}
