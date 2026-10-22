export function LinearProgress({ active, className }: { active: boolean; className?: string }) {
  return (
    <div className={`linear-progress${active ? ' linear-progress--active' : ''}${className ? ` ${className}` : ''}`} role="progressbar" aria-hidden={!active}>
      <div className="linear-progress__bar" />
    </div>
  );
}
