#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BUILD_VERSION "1.0.0-v5"

int main() {
    // Set console title
    SetConsoleTitleA("Bot Trading Next - Windows Console [V5 Key Level Sniper]");

    printf("========================================================\n");
    printf("   BOT TRADING NEXT (Windows Desktop Portable Engine)   \n");
    printf("   Strategy: V5 Key Level Sniper (BTCUSDT 5m 50x)       \n");
    printf("========================================================\n\n");

    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);

    // Get current working directory (where user launched the executable)
    char cwd[MAX_PATH];
    GetCurrentDirectoryA(MAX_PATH, cwd);

    // Get %LOCALAPPDATA% (fallback to %TEMP%)
    char localAppData[MAX_PATH] = {0};
    GetEnvironmentVariableA("LOCALAPPDATA", localAppData, MAX_PATH);
    if (strlen(localAppData) == 0) {
        GetEnvironmentVariableA("TEMP", localAppData, MAX_PATH);
    }

    char runtimeDir[MAX_PATH];
    snprintf(runtimeDir, MAX_PATH, "%s\\BotTradingNext\\runtime", localAppData);
    char verFile[MAX_PATH];
    snprintf(verFile, MAX_PATH, "%s\\version.txt", runtimeDir);

    // Check if runtime is already extracted and up-to-date
    int needExtract = 1;
    FILE *vf = fopen(verFile, "r");
    if (vf) {
        char buf[64] = {0};
        if (fgets(buf, sizeof(buf), vf)) {
            buf[strcspn(buf, "\r\n")] = 0;
            if (strcmp(buf, BUILD_VERSION) == 0) {
                needExtract = 0;
            }
        }
        fclose(vf);
    }

    if (needExtract) {
        printf("[SETUP] Preparing standalone portable runtime...\n");
        printf("        Location: %s\n", runtimeDir);
        printf("[SETUP] Extracting package, please wait a moment...\n\n");

        // Create runtime directory
        char mkdirCmd[MAX_PATH + 32];
        snprintf(mkdirCmd, sizeof(mkdirCmd), "cmd.exe /c mkdir \"%s\" >nul 2>&1", runtimeDir);
        system(mkdirCmd);

        // Extract embedded zip resource
        HRSRC hRes = FindResourceA(NULL, (LPCSTR)1, (LPCSTR)10 /* RT_RCDATA */);
        if (!hRes) {
            printf("[FATAL] Embedded payload resource not found!\n");
            printf("Press Enter to exit...");
            getchar();
            return 1;
        }

        HGLOBAL hMem = LoadResource(NULL, hRes);
        DWORD resSize = SizeofResource(NULL, hRes);
        void *pBytes = LockResource(hMem);

        char tempZip[MAX_PATH];
        snprintf(tempZip, MAX_PATH, "%s\\BotTradingNext\\payload.zip", localAppData);

        FILE *zf = fopen(tempZip, "wb");
        if (!zf) {
            printf("[FATAL] Could not write temporary bundle archive: %s\n", tempZip);
            printf("Press Enter to exit...");
            getchar();
            return 1;
        }
        fwrite(pBytes, 1, resSize, zf);
        fclose(zf);

        // Extract using Windows built-in tar.exe (libarchive handles zip)
        char extractCmd[MAX_PATH * 3 + 64];
        snprintf(extractCmd, sizeof(extractCmd), "tar.exe -xf \"%s\" -C \"%s\"", tempZip, runtimeDir);
        int ret = system(extractCmd);
        if (ret != 0) {
            // Fallback to powershell Expand-Archive
            snprintf(extractCmd, sizeof(extractCmd), 
                "powershell.exe -NoProfile -Command \"Expand-Archive -LiteralPath '%s' -DestinationPath '%s' -Force\"", 
                tempZip, runtimeDir);
            system(extractCmd);
        }

        // Cleanup temporary zip file
        DeleteFileA(tempZip);

        // Write version marker
        vf = fopen(verFile, "w");
        if (vf) {
            fprintf(vf, "%s\n", BUILD_VERSION);
            fclose(vf);
        }
        printf("[SETUP] Portable runtime ready!\n\n");
    }

    // Check if .env exists in current working directory; if not, create from template
    char envPath[MAX_PATH];
    snprintf(envPath, MAX_PATH, "%s\\.env", cwd);
    FILE *ef = fopen(envPath, "r");
    if (!ef) {
        char sampleEnv[MAX_PATH];
        snprintf(sampleEnv, MAX_PATH, "%s\\.env.example", runtimeDir);
        CopyFileA(sampleEnv, envPath, TRUE);
        printf("[CONFIG_NOTICE] Default '.env' template created in current folder:\n");
        printf("                %s\n", envPath);
        printf("                Please edit this file to configure your Binance API keys.\n\n");
    } else {
        fclose(ef);
    }

    // Configure runtime environment variables
    SetEnvironmentVariableA("DATA_DIR", cwd);
    SetEnvironmentVariableA("USE_REDIS", "false");
    SetEnvironmentVariableA("AUTO_OPEN_BROWSER", "true");

    char nodeExe[MAX_PATH];
    snprintf(nodeExe, MAX_PATH, "%s\\node.exe", runtimeDir);
    char entryScript[MAX_PATH];
    snprintf(entryScript, MAX_PATH, "%s\\src\\trading-core.js", runtimeDir);

    // Build process command line
    char cmdLine[MAX_PATH * 3 + 64];
    snprintf(cmdLine, sizeof(cmdLine), "\"%s\" \"%s\"", nodeExe, entryScript);

    printf("[LAUNCHER] Launching Bot Trading Core in: %s\n", cwd);
    printf("[LAUNCHER] Web Dashboard will open automatically at http://localhost:28080\n");
    printf("[LAUNCHER] Press Ctrl+C in this console window to stop the bot.\n\n");

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmdLine, NULL, NULL, TRUE, 0, NULL, cwd, &si, &pi)) {
        printf("[ERROR] Failed to start Trading Engine! Error code: %lu\n", GetLastError());
        printf("Press Enter to exit...");
        getchar();
        return 1;
    }

    // Wait until Node.js process exits
    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    return exitCode;
}

