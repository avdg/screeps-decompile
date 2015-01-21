#! /usr/bin/env node

// Usage: node <script name> [screeps engine.js file | url]
var fs = require('fs');
var http = require('http');
var path = require('path');

var settings;
var screepsEngineUrl = "http://screeps.com/a/engine.js";
var engineFile = "engine.js";
var errorNoSettings = "No settings found, please use setSettings()\n" +
    path.join(__dirname, "settings.default.json") +
    " contains a template if needed";
var appDir = path.join(
    process.env.APPDATA ||
        (process.platform == 'darwin' ? process.env.HOME + 'Library/Preference' : '/var/local'),
    'screeps-decompile/'
);
var engineFilePath = path.join(appDir, engineFile);

if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir);
}

var parseQuote = function(str, pos) {
    if (!(str[pos] === '"' || str[pos] === "'")) return false;

    var start = str[pos];
    var result = "";

    for (pos++; pos < str.length; pos++) {
        if (start === str[pos]) break;
        if ('\\' === str[pos] && pos + 1 < str.length) {
            pos++;
            switch (str[pos]) {
                case '"':
                case "'":
                    result += str[pos];
                    break;

                case '\\':
                    result += '\\';
                    break;

                case 'n':
                    result += '\n';
                    break;

                default:
                    throw 'Unknown \\' + str[pos];
            }
        } else {
            result += str[pos];
        }
    }

    return {
        pos: pos,
        str: result,
    };
};

var unstringify = function(input, result) {
    var parts = input.split('\n');
    var quotes = [];
    var data = {};

    var pos1, pos2;

    result.parts = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i] === "")
            if (i < (parts.lengt) - 1)
                throw 'Found unexpected empty line at ' + (i + 1);
            else
                break;

        data = {};

        // Look for quotes
        pos1 = parts[i].indexOf("'");
        pos2 = parts[i].indexOf('"');

        data.startPos = (pos1 === -1 || pos2 === -1) ? Math.max(pos1, pos2) : Math.min(pos1, pos2);

        if (data.startPos === -1) throw 'Cannot find quotes at line ' + (i + 1);

        // Parse
        pos1 = parseQuote(parts[i], data.startPos);
        if (pos1 === false) throw 'Parsing quote failed at line ' + (i + 1);

        data.endPos = pos1.pos;
        data.quoted = pos1.str;

        // Look for following quotes except the last 2 lines
        if (i < (parts.length - 2) && (
            parts[i].indexOf("'", data.endPos + 1) !== -1 ||
            parts[i].indexOf('"', data.endPos + 1) !== -1
        )) {
            throw 'Found multiple quotes at line ' + (i + 1);
        }

        result.parts[i] = data;
    }

    // Merge quoted code
    result.strCode = '';
    for (i = 0; i < result.parts.length; i++) {
        result.strCode += result.parts[i].quoted;
    }

    return result;
};

var moduleUnwrap = function(result) {
    // --- Guessing location ---
    // Find positions
    var pos1 = result.strCode.indexOf('}({');
    var pos2 = result.strCode.indexOf('},{},[');

    if (-1 === pos1)
        throw "Can't find start of modules";
    if (-1 === pos2)
        throw "Can't find end of modules";

    // Apply corrections
    pos1 += 2;

    // safety checks
    if (result.strCode[pos1 + 1] !== '1')
        throw "Code structure is unexpected";
    if (pos2 < 10000)
        throw "Code ends too soon";

    // Get modules
    result.moduleObjects = result.strCode.substr(pos1, pos2 - pos1 + 1);
};

var splitModules = function(result) {
    // --- parse the evil way ---
    result.modules = eval('(' + result.moduleObjects + ')');

    if (typeof result.modules !== "object")
        throw "couldn't convert modules code into js object";

    // --- collect module data ---
    result.moduleNames = {};
    for (var i in result.modules) {
        for (var j in result.modules[i][1]) {
            if (!result.moduleNames[result.modules[i][1][j]])
                result.moduleNames[result.modules[i][1][j]] = {};

            if (!(j in result.moduleNames[result.modules[i][1][j]])) {
                result.moduleNames[result.modules[i][1][j]][j] = [i];
            } else {
                result.moduleNames[result.modules[i][1][j]][j].push(i);
            }
        }
    }
};

var format = function(result) {
    var UglifyJS = require("uglify-js");
    function beautifyJS(code) {
        var beautifyOptions = {
            indent_start  : 0,
            indent_level  : 4,
            quote_keys    : false,
            space_colon   : true,
            ascii_only    : false,
            inline_script : false,
            width         : 80,
            max_line_len  : 32000,
            screw_ie8     : false,
            beautify      : true,
            bracketize    : false,
            comments      : false,
            semicolons    : false
        };
        var ast = UglifyJS.parse(code);
        return ast.print_to_string(beautifyOptions);
    }

    function formatModuleNames(input) {
        var output = "{\n";

        for (var i in result.moduleNames) {
            output += "  \"" + i + "\":{\n";

            for (var j in result.moduleNames[i]) {
                output += "    " + JSON.stringify(j);
                output += ": ";
                output += JSON.stringify(result.moduleNames[i][j]);
                output += ",\n";
            }

            output = output.substr(0, output.length - 2);
            output += "\n  },\n";
        }

        output = output.substr(0, output.length - 2);
        output += "\n}";
        return output;
    }

    result.strCodeFormatted = beautifyJS(result.strCode);
    result.moduleNamesFormatted = formatModuleNames(result.moduleNames);
    result.readme = fs.readFileSync(path.join(__dirname, 'jsonFormat.md'), {encoding: 'utf8'});
};

var decode = function(input) {
    var result = {};
    unstringify(input, result); // Result is passed by reference
    moduleUnwrap(result);
    splitModules(result);
    format(result);
    return result;
};

var processEngine = function(location) {
    if (settings === undefined) throw errorNoSettings;

    var file; // Filename as base for files to store content as
    var done = function(data) {
        var gistFiles = {};
        var files = [
            ['engineDecompiled',       'strCodeFormatted'],
            ['engineModules',          'moduleObjects'],
            ['engineModulesStructure', 'moduleNamesFormatted'],
            ['engineModulesHelp',      'readme'],
        ];
        result = decode(data);

        console.log('Writing files...');
        for (var i = 0; i < files.length; i++) {
            saveFile(file, files[i][0], result[files[i][1]]);
            saveGistFile(gistFiles, files[i][0], result[files[i][1]]);
        }

        if (Object.keys(gistFiles).length > 0) {
            console.log('Updating gist...');
            var github = require('github-api');
            var githubClient = new github({token: settings.githubAuth});
            var gist = githubClient.getGist(settings.gists[engineFile]);
            gist.update({
                description: "Decompilation screeps engine.js (as of " + new Date() + ")",
                files: gistFiles,
            }, function(err, gist) {});
        }
    };

    var content;
    if (location.search(/^https?:\/\//) !== -1) {
        file = path.join(process.cwd(), engineFile); // Imaginary file
        getFromUrl(location, function(data) {
            console.log("Writing engine.js");
            fs.writeFileSync(file, data);
            done(data);
        }, function(e) {
            console.log('failed to fetch content...');
            throw e;
        });
    } else {
        file = location;
        fs.readFile(location, {encoding: 'utf8'}, function(err, data) {
            if (err) throw [file, err];

            done(data);
        });
    }
};

var getFromUrl = function(url, done, err) {
    http.get(url, function(res) {
        var data = "";
        res.on("data", function(chunk) {
            data += chunk;
        });
        res.on("end", function(chunk) {
            done(data);
        });
    }).on('error', err || function(e){
        throw e;
    });
};

var compareEngineFiles = function(callback) {
    var file;
    var done = function(data) {
        setTimeout(function() {
            if (file === data) {
                console.log('Cached and online versions are the same');
            } else {
                console.log('Cached and online versions are different');
            }

            callback && callback(file !== data, data);
        }, 0);
    };

    console.log('Comparing files...');
    getFromUrl(screepsEngineUrl, done, function(e) {
        console.log('fetching engine.js from screeps.com failed');
        throw e;
    });
    file = fs.existsSync(engineFilePath) && fs.readFileSync(engineFilePath, {encoding: 'utf8'});
};

var saveFile = function(file, name, content) {
    if (settings.output[name].indexOf("file") === -1)
        return;

    fs.writeFileSync(file + settings.file[name], content);
};

var saveGistFile = function(gist, name, content) {
    if (settings.output[name].indexOf("gist") === -1)
        return;

    gist[settings.gist[name]] = {
        content: content
    };
};

var checkConfig = function(quit) {
    if (!fs.existsSync(path.join(appDir, "settings.json"))) {
        console.log("No settings file found");

        if (!fs.existsSync("_settings.json")) {
            console.log("Copying settings file...");
            fs.writeFileSync(path.join(appDir, "_settings.json"), fs.readFileSync(
                path.join(__dirname, "settings.default.json"), {encoding: 'utf8'}
            ));
        }
        console.log("\n1) Update settings in _settings.json");
        console.log("2) Rename _settings.json to settings.json when done");
        console.log("\nIf you want to reset _settings.json, please remove the file and rerun this command\n");
        console.log("The settings file can be found at:\n" + path.join(appDir, "./_settings.json") + "\n");

        if (quit === true) {
            process.exit(1);
        }
    }
};

var setSettings = function(s) {
    settings = s;
};

if (!module.parent) {
    var argv = process.argv.slice(process.argv[1] === "debug" ? 3 : 2);
    checkConfig(true);
    settings = JSON.parse(fs.readFileSync(path.join(appDir, "./settings.json"), {encoding: 'utf8'}));

    if (argv[0] && argv[0].indexOf('-') === 0) {
        switch(argv[0]) {
            case '--compare':
                compareEngineFiles();
                break;
            case '--config':
                console.log("Settings file can be found here:");
                console.log(path.join(appDir, "settings.json"));
                break;
            default:
                console.log('Unknown flag');
                process.exit(-1);
        }
    } else {
        if (!argv[0]) {
            compareEngineFiles(function(changed, data) {
                if (changed) {
                    console.log("Engine.js has changed... Updating...");
                    console.log("Writing engine.js to local dist...");
                    fs.writeFileSync(engineFilePath, data);
                    processEngine(engineFilePath);
                }
            });
        } else {
            processEngine(argv[0] || screepsEngineUrl);
        }
    }
} else {
    module.exports = {
        parseQuote: parseQuote,
        unstringify: unstringify,
        moduleUnwrap: moduleUnwrap,
        splitModules: splitModules,
        decode: decode,
        setSettings: setSettings,
    };
}
