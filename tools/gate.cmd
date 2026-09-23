@echo off
REM ============================================================
REM  EDIT GATE -- run this after EVERY batch of code edits.
REM
REM  Why it exists: I keep making the same two mistakes --
REM   1. an edit whose old_string only covered part of a block,
REM      so the new_string silently swallowed a neighbouring line
REM      (e.g. deleting "def render_doc_path(...)" and leaving its
REM      body orphaned -- the file still "looks" fine);
REM   2. .ps1/.cmd files written as UTF-8, which cmd.exe reads in
REM      the OEM codepage and mangles into broken commands.
REM  Both are caught in under 10 seconds here, so they never
REM  reach a render run again.
REM
REM  Checks: python syntax of the driver -> JS syntax of both
REM  plugin halves -> non-ASCII bytes in .cmd/.ps1 -> full suites.
REM ============================================================
setlocal
set PY=D:\Ai\ComfyUI\standalone-env\python.exe
set TOOLS=D:\Ai\DSH-plugins\dsh-manju-studio\tools
set FAIL=0

echo [1/5] python syntax of manju-headless.py
"%PY%" -X utf8 -c "import py_compile;py_compile.compile(r'%TOOLS%\manju-headless.py',doraise=True);print('  OK')"
if errorlevel 1 set FAIL=1

echo [2/5] orphaned def / unreachable body scan (whole tools/ dir)
REM NOTE: pass the tools dir explicitly. This step used to be called with NO paths,
REM so its loop never ran and it printed OK forever -- a gate check that checked nothing.
"%PY%" -X utf8 "%TOOLS%\gate_lint.py" "%TOOLS%"
if errorlevel 1 set FAIL=1

echo [3/5] non-ASCII bytes in .cmd / .ps1
"%PY%" -X utf8 "%TOOLS%\gate_ascii.py" "D:\Ai\Tools" "D:\Ai\DSH-plugins\dsh-manju-studio" "%USERPROFILE%\.dsh\skills"
if errorlevel 1 set FAIL=1

echo [4/5] module hygiene (cycles / package layout / oversized single files)
"%PY%" -X utf8 "%TOOLS%\gate_modules.py" "D:\Ai\DSH-plugins\dsh-manju-studio" "D:\Ai\Tools"
if errorlevel 1 set FAIL=1

echo [5/5] plugin suites
call "%TOOLS%\check.cmd"
if errorlevel 1 set FAIL=1

if "%FAIL%"=="1" (echo. & echo GATE FAILED -- fix before running anything) else (echo. & echo GATE PASSED)
exit /b %FAIL%
