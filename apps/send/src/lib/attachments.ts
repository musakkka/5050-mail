/**
 * File extensions Resend refuses as attachments (executables and scripts; mirrors the
 * "unsupported file types" list in Resend's attachment docs), plus `.jar`.
 */
const BLOCKED = new Set(
  (
    'adp app asp bas bat cer chm cmd com cpl crt csh der exe fxp gadget hlp hta inf ins isp its jar js jse ksh lib lnk ' +
    'mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz msc msh msh1 msh2 mshxml msh1xml msh2xml msi msp mst ' +
    'ops pcd pif plg prf prg reg scf scr sct shb shs sys ps1 ps1xml ps2 ps2xml psc1 psc2 tmp url vb vbe vbs vps vsmacros vss vst vsw vxd ' +
    'ws wsc wsf wsh xnk'
  ).split(' '),
);

/** The blocked extension (lowercase, no dot) of `filename`, or null when it is allowed. */
export function blockedExtension(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(filename);
  const ext = m?.[1]?.toLowerCase();
  return ext && BLOCKED.has(ext) ? ext : null;
}
