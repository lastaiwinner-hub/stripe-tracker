' Starts the Stripe Tracker server with no console window.
' Used by the scheduled task so the app comes back after a reboot.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "F:\CLAUDE PROJEC\stripe-tracker"
sh.Run "node server.js", 0, False
