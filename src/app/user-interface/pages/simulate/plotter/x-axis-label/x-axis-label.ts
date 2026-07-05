import './x-axis-label.scss';
import { LoadTemplate } from 'src/app/user-interface/template';

declare global {
    interface HTMLElementTagNameMap {
        'mcs-plotter-x-axis-label': PlotterXAxisLabel;
    }
}

@LoadTemplate('app/user-interface/pages/simulate/plotter/x-axis-label/x-axis-label.html')
export class PlotterXAxisLabel extends HTMLElement {
    private readonly _content = new DocumentFragment();

    private readonly _image: HTMLImageElement;

    constructor() {
        super();

        this._content.append(getTemplateNode('mcs-plotter-x-axis-label-template'));

        this._image = getElementFromFragment(this._content, 'mcs-plotter-x-axis-image', 'img');
    }

    public connectedCallback() {
        this.appendChild(this._content);
    }

    public _set(image: string) {
        this._image.src = image;
    }
}

customElements.define('mcs-plotter-x-axis-label', PlotterXAxisLabel);
