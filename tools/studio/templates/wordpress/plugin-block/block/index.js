/**
 * {{NAME}} — editor script of the block (no build step: plain JavaScript and the wp.* globals).
 * With a build tool (@wordpress/scripts) the same code can be written as JSX.
 */
( function ( wp ) {
	const el = wp.element.createElement;
	const { registerBlockType } = wp.blocks;
	const { RichText, InspectorControls, useBlockProps } = wp.blockEditor;
	const { PanelBody, ColorPalette } = wp.components;
	const { __ } = wp.i18n;

	registerBlockType( '{{SLUG}}/card', {
		edit: function ( props ) {
			const { attributes, setAttributes } = props;
			const blockProps = useBlockProps( {
				className: '{{SLUG}}-card',
				style: { borderTopColor: attributes.accent },
			} );
			return el(
				wp.element.Fragment,
				null,
				el(
					InspectorControls,
					null,
					el(
						PanelBody,
						{ title: __( 'Accent color', '{{SLUG}}' ) },
						el( ColorPalette, {
							value: attributes.accent,
							onChange: function ( value ) {
								setAttributes( { accent: value || '#2563eb' } );
							},
						} )
					)
				),
				el(
					'div',
					blockProps,
					el( RichText, {
						tagName: 'h3',
						className: '{{SLUG}}-card__title',
						value: attributes.title,
						placeholder: __( 'Title…', '{{SLUG}}' ),
						onChange: function ( value ) {
							setAttributes( { title: value } );
						},
					} ),
					el( RichText, {
						tagName: 'p',
						className: '{{SLUG}}-card__text',
						value: attributes.text,
						placeholder: __( 'Write something…', '{{SLUG}}' ),
						onChange: function ( value ) {
							setAttributes( { text: value } );
						},
					} )
				)
			);
		},

		// What is stored in the post: change it together with "edit" (WordPress compares both).
		save: function ( props ) {
			const { attributes } = props;
			const blockProps = useBlockProps.save( {
				className: '{{SLUG}}-card',
				style: { borderTopColor: attributes.accent },
			} );
			return el(
				'div',
				blockProps,
				el( RichText.Content, { tagName: 'h3', className: '{{SLUG}}-card__title', value: attributes.title } ),
				el( RichText.Content, { tagName: 'p', className: '{{SLUG}}-card__text', value: attributes.text } )
			);
		},
	} );
} )( window.wp );
