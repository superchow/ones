import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { AppError, requireThat } from './domain/model.ts'
import { resolveFolders } from './local-git.ts'

// Static code only; paths and other panel input are never interpolated into PowerShell.
// IFileOpenDialog flags and GetResults follow the Windows Common Item Dialog contract.
export const nativeFolderScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OnesFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index); void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie); void Unadvise(uint cookie);
    void SetOptions(uint options); void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder); void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder); void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item); void AddPlace(IShellItem item, uint alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result); void SetClientGuid(ref Guid guid); void ClearClientData(); void SetFilter(IntPtr filter);
    void GetResults(out IShellItemArray items); void GetSelectedItems(out IShellItemArray items);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent); void GetDisplayName(uint kind, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes); void Compare(IShellItem other, uint hint, out int order);
  }
  [ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemArray {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetPropertyStore(uint flags, ref Guid iid, out IntPtr store);
    void GetPropertyDescriptionList(IntPtr key, ref Guid iid, out IntPtr list);
    void GetAttributes(uint flags, uint mask, out uint attributes);
    void GetCount(out uint count); void GetItemAt(uint index, out IShellItem item); void EnumItems(out IntPtr items);
  }
  const uint FolderOptions = 0x20 | 0x40 | 0x200 | 0x800 | 0x1000 | 0x02000000;
  static IFileOpenDialog Create() {
    IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialog();
    uint options; dialog.GetOptions(out options); dialog.SetOptions(options | FolderOptions);
    dialog.SetTitle("选择本地项目文件夹（可按 Ctrl 多选）"); dialog.SetOkButtonLabel("添加项目文件夹");
    return dialog;
  }
  public static bool Probe() {
    IFileOpenDialog dialog = Create();
    try { uint options; dialog.GetOptions(out options); return (options & FolderOptions) == FolderOptions; }
    finally { Marshal.FinalReleaseComObject(dialog); }
  }
  public static string[] Pick(IntPtr owner) {
    IFileOpenDialog dialog = Create(); IShellItemArray items = null;
    try {
      int result = dialog.Show(owner);
      if (result == unchecked((int)0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(result);
      dialog.GetResults(out items); uint count; items.GetCount(out count);
      if (count > 20) throw new InvalidOperationException("too many folders");
      List<string> paths = new List<string>();
      for (uint i = 0; i < count; i++) {
        IShellItem item; items.GetItemAt(i, out item); IntPtr name = IntPtr.Zero;
        try { item.GetDisplayName(0x80058000, out name); paths.Add(Marshal.PtrToStringUni(name)); }
        finally { if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name); Marshal.FinalReleaseComObject(item); }
      }
      return paths.ToArray();
    } finally { if (items != null) Marshal.FinalReleaseComObject(items); Marshal.FinalReleaseComObject(dialog); }
  }
}
'@
if ($env:ONES_PICKER_CHECK_ONLY -eq '1') { [Console]::Write([OnesFolderPicker]::Probe()); exit }
# An owned dialog stays with Orca instead of getting hidden behind its main window.
$owner = [IntPtr]::Zero
foreach ($candidate in [Diagnostics.Process]::GetProcessesByName('orca')) {
  if ($candidate.MainWindowHandle -ne [IntPtr]::Zero) { $owner = $candidate.MainWindowHandle; break }
}
$paths = [OnesFolderPicker]::Pick($owner)
$result = @{ paths = @($paths | Where-Object { $null -ne $_ }); cancelled = ($null -eq $paths) }
[Console]::Write((ConvertTo-Json -InputObject $result -Compress))
`

export type FolderSelection = { paths: string[]; cancelled: boolean }
export function decodeFolderSelection(output: string): FolderSelection {
  let value: FolderSelection
  try { value = JSON.parse(output) } catch { throw new AppError('picker', '系统选择器未返回有效结果，请手动录入项目路径。') }
  requireThat(value && typeof value.cancelled === 'boolean' && Array.isArray(value.paths) && value.paths.length <= 20 && value.paths.every(p => typeof p === 'string') && (!value.cancelled || value.paths.length === 0), 'picker', '系统选择器返回异常，请手动录入项目路径。')
  return value
}

export class NativeFolderPicker {
  private active = false
  async pick(signal?: AbortSignal): Promise<FolderSelection> {
    requireThat(process.platform === 'win32', 'picker', '当前系统暂不支持原生目录选择，请手动录入项目路径。')
    requireThat(!this.active, 'picker', '已有文件夹选择器打开，请完成或取消后重试。')
    this.active = true
    try {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
      const output = await new Promise<string>((resolve, reject) => {
        execFile(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(nativeFolderScript, 'utf16le').toString('base64')],
          { windowsHide: true, timeout: 90000, maxBuffer: 128 * 1024, encoding: 'utf8', signal, env: { ...process.env, SystemRoot: systemRoot, ONES_PICKER_CHECK_ONLY: '0' } },
          (error, stdout) => error ? reject(new AppError('picker', signal?.aborted ? '已取消打开选择器，可手动录入项目路径。' : '系统文件夹选择器未能完成或已超时，请手动录入项目路径。')) : resolve(stdout))
      })
      const result = decodeFolderSelection(output)
      return result.cancelled ? result : { cancelled: false, paths: await resolveFolders(result.paths) }
    } finally { this.active = false }
  }
}
