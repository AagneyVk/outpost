using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

internal static class OutpostLauncher
{
    private static int Main(string[] args)
    {
        bool smoke = args.Length == 1 && args[0] == "--check";
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string inspectionDirectory = Path.Combine(directory, "local-inspection");
        string runtimeDirectory = null;
        const string origin = "http://127.0.0.1:3018";
        try
        {
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("OutpostRuntime"))
            {
                if (payload != null)
                {
                    if (!smoke) Console.WriteLine("Opening OUTPOST…");
                    runtimeDirectory = Path.Combine(Path.GetTempPath(), "outpost-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(runtimeDirectory);
                    using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                        archive.ExtractToDirectory(runtimeDirectory);
                    directory = runtimeDirectory;
                }
            }
            if (!File.Exists(Path.Combine(directory, "server.mjs")))
                throw new InvalidOperationException("Keep OUTPOST.exe beside server.mjs in the OUTPOST folder.");
            string bundledNode = Path.Combine(directory, "node.exe");
            var options = new ProcessStartInfo
            {
                FileName = File.Exists(bundledNode) ? bundledNode : "node.exe",
                Arguments = "server.mjs --direct-local",
                WorkingDirectory = directory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };
            options.EnvironmentVariables["OUTPOST_PORT"] = "3018";
            options.EnvironmentVariables["OUTPOST_INSPECTION_DIR"] = inspectionDirectory;
            options.EnvironmentVariables.Remove("OUTPOST_BIND");
            options.EnvironmentVariables.Remove("OUTPOST_ORIGIN");
            options.EnvironmentVariables.Remove("OUTPOST_SOCKS_PORT");
            options.EnvironmentVariables.Remove("OUTPOST_PUBLIC_PREVIEW");
            using (Process helper = Process.Start(options))
            {
                ConsoleCancelEventHandler stop = delegate {
                    if (!helper.HasExited) helper.Kill();
                };
                Console.CancelKeyPress += stop;
                try
                {
                    var startup = helper.StandardOutput.ReadLineAsync();
                    if (!startup.Wait(10000))
                        throw new InvalidOperationException("OUTPOST took too long to start.");
                    // The helper emits this only after binding the loopback port.
                    if (startup.Result != "OUTPOST: " + origin)
                        throw new InvalidOperationException("OUTPOST could not start. Check that port 3018 is free and the OUTPOST files are present.");
                    string url = origin + "/gecko-lab/index.html?launch=direct";
                    Console.WriteLine(url);
                    if (smoke) return 0;
                    Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                    Console.WriteLine("Keep this window open while browsing. Press Enter here to stop OUTPOST.");
                    Console.ReadLine();
                    return 0;
                }
                finally
                {
                    Console.CancelKeyPress -= stop;
                    if (!helper.HasExited) helper.Kill();
                    helper.WaitForExit();
                }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            if (!smoke && !Console.IsInputRedirected)
            {
                Console.WriteLine("Press Enter to close.");
                Console.ReadLine();
            }
            return 1;
        }
        finally
        {
            if (runtimeDirectory != null)
            {
                try { Directory.Delete(runtimeDirectory, true); }
                catch (IOException) { Console.Error.WriteLine("Could not remove temporary runtime files."); }
                catch (UnauthorizedAccessException) { Console.Error.WriteLine("Could not remove temporary runtime files."); }
            }
        }
    }
}
