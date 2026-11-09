// Workbench.exe: the program Windows runs for workbench:// links. It only starts
// `node server.mjs --url <link>` without a window and returns.
// A real program, not a script host: the browser names the handler in its "Open …?" prompt from this
// file's description, and browsers and security tools treat a browser starting wscript as suspicious.
// Built by register-protocol.ps1 with the C# compiler that ships with Windows.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("Workbench")]
[assembly: AssemblyProduct("Workbench")]
[assembly: AssemblyDescription("Starts and stops Workbench card sessions")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Launcher {
  static int Main(string[] args) {
    if (args.Length == 0) return 1;
    string here = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    string node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "fnm", "aliases", "default", "node.exe");
    if (!File.Exists(node)) node = "node";
    var start = new ProcessStartInfo(node, "\"" + Path.Combine(here, "server.mjs") + "\" --url \"" + args[0].Replace("\"", "") + "\"") {
      UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = here,
    };
    try { Process.Start(start); } catch { return 2; }
    return 0;
  }
}
