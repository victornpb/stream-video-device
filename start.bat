@echo off
set NODE_OPTIONS="--disable-warning=DEP0040"
:start
node --watch index.js
goto start