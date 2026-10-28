@echo off
chcp 65001 >nul
title Painel gerencial (teste local)
cd /d "%~dp0"
rem Uso local, so neste computador. No servidor da empresa use servidor\instalar.bat.
start "" http://localhost:3007/
python app.py
if errorlevel 1 (
  echo.
  echo O painel foi encerrado com erro. Veja a mensagem acima.
  pause
)
