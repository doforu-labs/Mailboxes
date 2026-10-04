// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	RotateCw,
	RotateCcw,
	Unlink,
	Link,
	List,
	ListOrdered,
	Minus,
	Quote,
	Bold,
	Italic,
	Strikethrough,
	Underline as UnderlineIcon,
} from "lucide-react";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface RichTextEditorProps {
	value: string;
	onChange: (value: string) => void;
}

export default function RichTextEditor({
	value,
	onChange,
}: RichTextEditorProps) {
	const { t } = useTranslation("editor");

	const editor = useEditor({
		extensions: [
			StarterKit,
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure({ openOnClick: false }),
			TiptapImage,
			TextStyle,
			Color,
			Highlight.configure({ multicolor: true }),
		],
		content: value,
		editorProps: {
			attributes: {
				class:
					"prose prose-sm max-w-none focus:outline-none min-h-[180px] p-3 text-sm [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_blockquote]:bg-kumo-tint [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-xs [&_blockquote]:rounded-r-sm",
			},
		},
		onUpdate: ({ editor }) => {
			onChange(editor.getHTML());
		},
	});

	useEffect(() => {
		if (editor && !editor.isDestroyed && value !== editor.getHTML()) {
			editor.commands.setContent(value);
			// Place cursor at the start of the document (above quoted text)
			const rafId = requestAnimationFrame(() => {
				if (!editor.isDestroyed) {
					editor.commands.focus('start');
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [value, editor]);

	const setLink = useCallback(() => {
		if (!editor) return;
		const previousUrl = editor.getAttributes("link").href;
		const url = window.prompt(t("urlPrompt"), previousUrl);
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
	}, [editor, t]);

	if (!editor) return null;

	return (
		<div className="rounded-lg border border-kumo-line overflow-hidden flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-0.5 bg-kumo-recessed px-2 py-1.5 border-b border-kumo-line shrink-0">
				{/* Text formatting */}
				<Tooltip content={t("bold")} side="bottom" asChild>
					<Button
						variant={editor.isActive("bold") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<Bold size={16} />}
						onClick={() => editor.chain().focus().toggleBold().run()}
						aria-label={t("bold")}
					/>
				</Tooltip>
				<Tooltip content={t("italic")} side="bottom" asChild>
					<Button
						variant={editor.isActive("italic") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<Italic size={16} />}
						onClick={() => editor.chain().focus().toggleItalic().run()}
						aria-label={t("italic")}
					/>
				</Tooltip>
				<Tooltip content={t("underline")} side="bottom" asChild>
					<Button
						variant={editor.isActive("underline") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<UnderlineIcon size={16} />}
						onClick={() => editor.chain().focus().toggleUnderline().run()}
						aria-label={t("underline")}
					/>
				</Tooltip>
				<Tooltip content={t("strikethrough")} side="bottom" asChild>
					<Button
						variant={editor.isActive("strike") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<Strikethrough size={16} />}
						onClick={() => editor.chain().focus().toggleStrike().run()}
						aria-label={t("strikethrough")}
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Lists */}
				<Tooltip content={t("bulletList")} side="bottom" asChild>
					<Button
						variant={editor.isActive("bulletList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<List size={16} />}
						onClick={() => editor.chain().focus().toggleBulletList().run()}
						aria-label={t("bulletList")}
					/>
				</Tooltip>
				<Tooltip content={t("numberedList")} side="bottom" asChild>
					<Button
						variant={editor.isActive("orderedList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<ListOrdered size={16} />}
						onClick={() => editor.chain().focus().toggleOrderedList().run()}
						aria-label={t("numberedList")}
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Block formatting */}
				<Tooltip content={t("blockquote")} side="bottom" asChild>
					<Button
						variant={editor.isActive("blockquote") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<Quote size={16} />}
						onClick={() => editor.chain().focus().toggleBlockquote().run()}
						aria-label={t("blockquote")}
					/>
				</Tooltip>
				<Tooltip content={t("link")} side="bottom" asChild>
					<Button
						variant={editor.isActive("link") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<Link size={16} />}
						onClick={setLink}
						aria-label={t("link")}
					/>
				</Tooltip>
				{editor.isActive("link") && (
					<Tooltip content={t("removeLink")} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<Unlink size={16} />}
							onClick={() => editor.chain().focus().unsetLink().run()}
							aria-label={t("removeLink")}
						/>
					</Tooltip>
				)}
				<Tooltip content={t("horizontalRule")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<Minus size={16} />}
						onClick={() => editor.chain().focus().setHorizontalRule().run()}
						aria-label={t("horizontalRule")}
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Undo/Redo */}
				<Tooltip content={t("undo")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<RotateCcw size={16} />}
						onClick={() => editor.chain().focus().undo().run()}
						disabled={!editor.can().undo()}
						aria-label={t("undo")}
					/>
				</Tooltip>
				<Tooltip content={t("redo")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<RotateCw size={16} />}
						onClick={() => editor.chain().focus().redo().run()}
						disabled={!editor.can().redo()}
						aria-label={t("redo")}
					/>
				</Tooltip>
			</div>

			{/* Editor content */}
			<div className="flex-1 overflow-y-auto">
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
