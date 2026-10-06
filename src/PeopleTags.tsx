import { useEffect, useMemo, useRef, useState } from "react";
import type { PersonTag } from "../shared/creative";
import type { UploadedMedia } from "./media";
import type { PublicationType } from "./types";

export function PeopleTags({ item, type, onSave, onClose }: { item: UploadedMedia; type: PublicationType; onSave: (tags: PersonTag[]) => void; onClose: () => void }) {
  const story = type === "story", positioned = story || item.file.type.startsWith("image/");
  const [tags, setTags] = useState(item.options.tags), [username, setUsername] = useState("");
  const [selected, setSelected] = useState<number>(), [ratio, setRatio] = useState(story ? 9 / 16 : 1);
  const [error, setError] = useState("");
  const media = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const drag = useRef<number | undefined>(undefined);
  const url = useMemo(() => URL.createObjectURL(item.file), [item.file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; input.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  const add = () => {
    const name = username.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(name)) { setError("Enter an Instagram username, such as @classmate."); return; }
    if (tags.some(t => t.username.toLowerCase() === name.toLowerCase())) { setError("This person is already added."); return; }
    if (tags.length >= 20) { setError("You can add up to 20 people."); return; }
    setTags([...tags, { username: name, x: .5, y: Math.min(.85, .65 + (tags.length % 3) * .08) }]); setSelected(tags.length); setUsername(""); setError("");
  };
  const position = (index: number, clientX: number, clientY: number) => {
    const rect = media.current?.getBoundingClientRect(); if (!rect) return;
    const x = Math.max(.04, Math.min(.96, (clientX - rect.left) / rect.width)), y = Math.max(.04, Math.min(.96, (clientY - rect.top) / rect.height));
    setTags(current => current.map((tag, i) => i === index ? { ...tag, x, y } : tag));
  };
  return <div className="tags-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={dialog} className="people-tags-dialog" role="dialog" aria-modal="true" aria-label={story ? "Story mentions" : "Tag people"} onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    if (e.key !== "Tab") return;
    const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>("button, input") ?? [])].filter(n => n.getClientRects().length && !n.hasAttribute("disabled"));
    if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
  }}>
    <header className="tags-header"><div><h2>{story ? "Mention friends" : "Tag people"}</h2><p>{positioned ? "Add a username, then drag its label into place." : "Add the people who appear in this video."}</p></div><button type="button" className="icon-button" aria-label="Close mentions" onClick={onClose}>×</button></header>
    <div className="tags-body"><div className="tags-preview-panel"><span className="preview-label">Placement preview</span><div className="tags-stage" style={{ width: `min(100%, ${Math.min(360, 350 * ratio)}px)`, aspectRatio: ratio }}>
      <div ref={media} className="tags-media">
        {item.file.type.startsWith("image/") ? <img src={url} alt="Mention placement preview" draggable={false} onLoad={e => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} /> : <video src={url} controls playsInline onLoadedMetadata={e => { if (e.currentTarget.videoWidth) setRatio(e.currentTarget.videoWidth / e.currentTarget.videoHeight); }} />}
        {positioned && tags.map((tag, index) => <button type="button" key={tag.username} className={`person-marker${story ? " story-mention" : ""}${selected === index ? " selected" : ""}`} aria-label={`Position @${tag.username}`} style={{ left: `${tag.x * 100}%`, top: `${tag.y * 100}%` }} onClick={() => setSelected(index)} onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setSelected(index); drag.current = index; }} onPointerMove={e => { if (drag.current === index && e.currentTarget.hasPointerCapture(e.pointerId)) position(index, e.clientX, e.clientY); }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} onKeyDown={e => {
          const movement = { ArrowLeft: [-.01, 0], ArrowRight: [.01, 0], ArrowUp: [0, -.01], ArrowDown: [0, .01] }[e.key];
          if (movement) { e.preventDefault(); setTags(current => current.map((t, i) => i === index ? { ...t, x: Math.max(.04, Math.min(.96, t.x + movement[0])), y: Math.max(.04, Math.min(.96, t.y + movement[1])) } : t)); }
        }}>@{tag.username}</button>)}
      </div>
    </div><p className="field-hint">{story ? "The label shows where you are placing the mention. Instagram controls its final appearance; this preview does not choose its font or size. Your media stays unchanged." : "These labels help you place tags. Instagram displays its own people tags, which viewers can tap to see. The labels are not printed on your photo or video."}</p></div>
    <div className="tags-controls"><form onSubmit={e => { e.preventDefault(); add(); }}><label>Instagram username<input ref={input} className="text-input" aria-label="Instagram username" placeholder="@classmate" maxLength={31} value={username} onChange={e => setUsername(e.target.value)} /></label><button type="submit" className="secondary-button">{story ? "Add mention" : "Add person"}</button></form>{error && <p className="notice notice-error" role="alert">{error}</p>}<div className="people-list">{tags.map((tag, index) => <div className="person-row" key={tag.username}><button type="button" className="text-button" aria-pressed={selected === index} onClick={() => setSelected(index)}>@{tag.username}</button><button type="button" className="icon-button" aria-label={`Remove @${tag.username}`} onClick={() => { setTags(tags.filter((_, i) => i !== index)); setSelected(undefined); }}>×</button></div>)}</div>{!tags.length && <p className="field-hint">No {story ? "mentions" : "people"} added yet.</p>}</div></div>
    <footer className="tags-footer"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" onClick={() => onSave(tags)}>Save {story ? "mentions" : "tags"}</button></footer>
  </div></div>;
}
