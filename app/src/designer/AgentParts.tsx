import { useId, useRef, useState, type ReactNode } from 'react';
import { addTool, changeDescription, changeInstructions, readForm, removeTool } from './agent-form';
import { builtInTools } from './built-in-tools';

function Unavailable({ label, reason, children }: { label: string; reason: string; children: ReactNode }) {
  return <span className="coming-control" tabIndex={0} role="group" aria-label={`${label}: ${reason}`} title={reason}>
    {children}<span className="control-tip" aria-hidden="true">{reason}</span>
  </span>;
}
export default function AgentParts({ source, path, readOnly, onChange }: {
  source: string; path?: string; readOnly: boolean; onChange: (source: string) => void;
}) {
  const form = readForm(source); const id = useId();
  const [picker, setPicker] = useState(false); const [query, setQuery] = useState('');
  const add = useRef<HTMLButtonElement>(null);
  const change = (value: string) => { if (!readOnly && value !== source) onChange(value); };
  const close = () => { setPicker(false); setQuery(''); add.current?.focus(); };
  const choices = Object.entries(builtInTools).filter(([name, label]) =>
    !form.tools.some(tool => tool.builtin && tool.name === name) && `${label} ${name}`.toLowerCase().includes(query.toLowerCase()));
  const toolReason = readOnly ? 'You can change tools after setup.' : 'Edit tools in File view for this file’s format.';
  const modelReason = 'Model selection is coming when a workspace catalog is available.';
  const soulReason = 'Personality editing is coming. Running personality settings is not supported yet.';
  const resourceReason = 'Tool resources are coming. Only built-in tools can be added here.';
  return <div className="agent-parts">
    {!form.metadataEditable && <p className="muted">This file’s settings can be edited in File view.</p>}
    <div className="agent-part">
      <div className="instructions-heading"><label htmlFor={`${id}-instructions`}>Instructions</label><p className="muted" id={`${id}-hint`}>What the agent should do, in your own words.</p></div>
      <textarea id={`${id}-instructions`} className="instructions-editor" aria-describedby={`${id}-hint`} value={form.instructions}
        readOnly={readOnly || !form.instructionsEditable} onChange={event => change(changeInstructions(source, event.target.value))} />
      {!form.instructionsEditable && <p className="muted">Finish the file’s opening settings in File view to edit its instructions here.</p>}
    </div>
    <section className="agent-part" aria-labelledby={`${id}-tools`}>
      <h3 id={`${id}-tools`}>It can use</h3>
      <div className="agent-tool-row">
        {form.tools.map(tool => {
          const name = tool.name ?? 'Unrecognised tool entry'; const label = tool.builtin && Object.hasOwn(builtInTools, name) ? builtInTools[name] : undefined;
          return <span className="tool-pill" key={tool.index}>
            <span>{label ?? name}</span>{label && <code>{name}</code>}
            {tool.builtin ? !readOnly && form.toolsEditable && <button type="button" className="tool-remove" aria-label={`Remove ${label ?? name}`} onClick={() => { change(removeTool(source, tool.index)); add.current?.focus(); }}>×</button>
              : <span className="muted">(Tool resource, editing coming)</span>}
          </span>;
        })}
        {readOnly || !form.toolsEditable ? <Unavailable label="Add a tool" reason={toolReason}><button className="part-button" type="button" disabled title={toolReason}>Add a tool</button></Unavailable>
          : <button className="part-button" type="button" ref={add} aria-expanded={picker} aria-controls={`${id}-picker`} onClick={() => { if (picker) close(); else setPicker(true); }}><span aria-hidden="true">+ </span>Add a tool</button>}
        <Unavailable label="Tool resources" reason={resourceReason}><button className="part-button" type="button" disabled title={resourceReason}>Tool resources</button></Unavailable>
      </div>
      {picker && !readOnly && form.toolsEditable && <div id={`${id}-picker`} className="tool-picker" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
        <label htmlFor={`${id}-search`}>Find a built-in tool</label>
        <input id={`${id}-search`} type="search" autoFocus value={query} onChange={event => setQuery(event.target.value)} />
        <p className="muted">Built-in tools known to Orka. Availability depends on your workspace.</p>
        <ul aria-label="Built-in tools">{choices.map(([name, label]) => <li key={name}><button type="button" onClick={() => { change(addTool(source, name)); close(); }}><span>{label}</span><code>{name}</code></button></li>)}</ul>
        {!choices.length && <p className="muted">No matching tools to add.</p>}
        <button className="part-button" type="button" onClick={close}>Close picker</button>
      </div>}
    </section>
    <div className="agent-part">
      <label htmlFor={`${id}-model`}>It thinks with</label>
      <div className="agent-tool-row">
        <Unavailable label="It thinks with" reason={modelReason}><select id={`${id}-model`} className="part-button" disabled title={modelReason} value={form.model ?? ''}><option value={form.model ?? ''}>{form.model ?? 'No model in this file'}</option></select></Unavailable>
        <span className="muted">Not checked against your workspace</span>
      </div>
    </div>
    <details className="agent-settings">
      <summary>More settings: description, personality (soul), file</summary>
      <div className="agent-part">
        <label htmlFor={`${id}-description`}>Description</label>
        <textarea id={`${id}-description`} className="description-editor" readOnly={readOnly || !form.descriptionEditable} value={form.description ?? ''}
          onChange={event => change(changeDescription(source, event.target.value))} />
        {!form.descriptionEditable && <p className="muted">Edit the description in File view for this file’s format.</p>}
      </div>
      <div className="agent-part">
        <label htmlFor={`${id}-soul`}>Personality (soul)</label>
        <Unavailable label="Personality (soul)" reason={soulReason}><textarea id={`${id}-soul`} className="description-editor" disabled title={soulReason} placeholder="Personality editing is coming" /></Unavailable>
      </div>
      <div className="agent-part"><h3>File</h3><p className="agent-path">{path ?? (readOnly ? 'The example gets its own folder after setup.' : 'The file path is unavailable.')}</p></div>
    </details>
  </div>;
}
