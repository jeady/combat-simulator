import CopyPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import { resolve } from 'path';
import { Configuration, DefinePlugin } from 'webpack';

const isProduction = process.argv[process.argv.indexOf('--mode') + 1] === 'production';

// Build stamp injected into the bundle so the UI can show which build is actually loaded. The zip's
// `--NNNN` filename suffix is computed later at packaging time and isn't available inside the bundle.
const buildStamp = `v${process.env.npm_package_version || '?'} · ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;

const config: Configuration = {
    mode: 'development',
    entry: { setup: 'src/setup.ts', worker: 'src/worker/setup.ts' },
    output: {
        filename: '[name].mjs',
        path: resolve(__dirname, '.output'),
        library: {
            type: 'module'
        },
        clean: true
    },
    experiments: {
        outputModule: true
    },
    performance: {
        hints: false,
        maxEntrypointSize: 512000,
        maxAssetSize: 512000
    },
    plugins: [
        new DefinePlugin({ __MCS_BUILD__: JSON.stringify(buildStamp) }),
        new CopyPlugin({
            patterns: [
                { from: '**/*.html', to: '[path][name][ext]', context: 'src', noErrorOnMissing: true },
                { from: 'manifest.json', to: 'manifest.json', context: 'src', noErrorOnMissing: true },
                { from: 'assets', to: 'assets', noErrorOnMissing: true }
            ]
        })
    ],
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        modules: [resolve('./node_modules'), resolve('.')]
    },
    module: {
        rules: [
            {
                test: /\.s[ac]ss$/i,
                use: ['style-loader', 'css-loader', 'sass-loader']
            },
            {
                test: /\.css$/i,
                use: ['style-loader', 'css-loader']
            },
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    }
};

if (!isProduction) {
    config.devtool = 'inline-source-map';
    config.optimization = {
        minimize: false,
        minimizer: [
            new TerserPlugin({
                terserOptions: {
                    mangle: false,
                    compress: false,
                    keep_classnames: true,
                    keep_fnames: true,
                    sourceMap: false
                }
            })
        ]
    };
} else {
    config.optimization = {
        minimizer: [
            new TerserPlugin({
                terserOptions: {
                    mangle: false,
                    keep_classnames: true,
                    keep_fnames: true
                }
            })
        ]
    };
}

export default config;
