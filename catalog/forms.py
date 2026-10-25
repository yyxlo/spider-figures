from django import forms
from django.core.exceptions import ValidationError

from .models import Family, Figure, Genus, Reference, Species, Structure


class AutocompleteWidget(forms.HiddenInput):
    """Hidden id field paired with a visible text box driven by static/js/app.js.

    kind: "species" or "reference" (selects the JSON endpoint).
    """

    template_name = "catalog/widgets/autocomplete.html"

    def __init__(self, kind, placeholder="", attrs=None):
        self.kind = kind
        self.placeholder = placeholder
        super().__init__(attrs)

    def get_context(self, name, value, attrs):
        ctx = super().get_context(name, value, attrs)
        label = ""
        if value:
            model = Species if self.kind == "species" else Reference
            obj = model.objects.filter(pk=value).first()
            if obj is not None:
                label = obj.full_name if self.kind == "species" else str(obj)
        ctx["widget"].update(kind=self.kind, label=label, placeholder=self.placeholder)
        return ctx


class MultipleFileInput(forms.ClearableFileInput):
    allow_multiple_selected = True


class MultipleImageField(forms.ImageField):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("widget", MultipleFileInput(attrs={"accept": "image/*"}))
        super().__init__(*args, **kwargs)

    def clean(self, data, initial=None):
        single = super().clean
        if isinstance(data, (list, tuple)):
            return [single(d, initial) for d in data]
        return [single(data, initial)] if data else []


class ReferenceForm(forms.ModelForm):
    class Meta:
        model = Reference
        fields = ["authors", "year", "title", "journal", "volume", "issue", "pages",
                  "publisher", "doi", "url", "wsc_ref_id", "notes"]
        widgets = {"title": forms.Textarea(attrs={"rows": 2}), "notes": forms.Textarea(attrs={"rows": 2})}


class UploadForm(forms.Form):
    species = forms.ModelChoiceField(
        Species.objects.all(), label="物種（圖上使用的名稱）",
        widget=AutocompleteWidget("species", "輸入學名或中文名，例如 Araneus ventricosus"),
        error_messages={"required": "請從清單中選擇物種"},
    )
    reference = forms.ModelChoiceField(
        Reference.objects.all(), label="出處文獻", required=False,
        widget=AutocompleteWidget("reference", "輸入作者、年份或標題"),
    )
    images = MultipleImageField(label="圖片檔（可多選）")
    structure = forms.ModelChoiceField(Structure.objects.all(), label="構造（預設值）", required=False)
    sex = forms.ChoiceField(choices=Figure.SEX_CHOICES, label="性別（預設值）", required=False)
    view = forms.ChoiceField(choices=Figure.VIEW_CHOICES, label="視角（預設值）", required=False)
    page = forms.CharField(label="頁碼（預設值）", required=False, max_length=30)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ref_form = ReferenceForm(*args, prefix="ref", **kwargs)
        self.new_reference_requested = bool(self.data.get("new_reference"))

    def is_valid(self):
        valid = super().is_valid()
        if self.new_reference_requested:
            valid = self.ref_form.is_valid() and valid
        return valid

    def clean(self):
        data = super().clean()
        if not self.new_reference_requested and not data.get("reference"):
            self.add_error("reference", "請選擇既有文獻，或勾選「新增文獻」並填寫資料")
        return data

    def get_reference(self):
        if self.new_reference_requested:
            return self.ref_form.save()
        return self.cleaned_data["reference"]


class FigureEditForm(forms.ModelForm):
    class Meta:
        model = Figure
        fields = ["species", "reference", "figure_number", "page", "structure", "sex", "view", "notes"]
        widgets = {
            "species": AutocompleteWidget("species"),
            "reference": AutocompleteWidget("reference"),
            "notes": forms.Textarea(attrs={"rows": 2}),
        }


class FigureBatchForm(forms.ModelForm):
    class Meta:
        model = Figure
        fields = ["figure_number", "page", "structure", "sex", "view", "notes"]
        widgets = {"notes": forms.TextInput()}


FigureBatchFormSet = forms.modelformset_factory(Figure, form=FigureBatchForm, extra=0)


class SpeciesCreateForm(forms.Form):
    genus_name = forms.CharField(label="屬名", max_length=100)
    family = forms.ModelChoiceField(Family.objects.all(), label="科（僅在新增屬時需要）", required=False)
    epithet = forms.CharField(label="種小名", max_length=100)
    subspecies = forms.CharField(label="亞種名", max_length=100, required=False)
    author = forms.CharField(label="命名者與年代", max_length=200, required=False,
                             help_text="例如 (Thorell, 1890)")
    common_name = forms.CharField(label="中文名", max_length=100, required=False)
    valid_species = forms.ModelChoiceField(
        Species.objects.all(), label="有效名（若此名為同物異名）", required=False,
        widget=AutocompleteWidget("species", "若是有效名請留空"),
    )

    def clean_genus_name(self):
        return self.cleaned_data["genus_name"].strip().capitalize()

    def clean_epithet(self):
        return self.cleaned_data["epithet"].strip().lower()

    def clean_subspecies(self):
        return self.cleaned_data["subspecies"].strip().lower()

    def clean(self):
        data = super().clean()
        genus_name = data.get("genus_name")
        if not genus_name:
            return data
        genus = Genus.objects.filter(name__iexact=genus_name).first()
        if genus is None and not data.get("family"):
            self.add_error("family", f"名錄中沒有 {genus_name} 屬，請選擇所屬的科以新增此屬")
        if genus is not None and Species.objects.filter(
            genus=genus, epithet=data.get("epithet"), subspecies=data.get("subspecies", "")
        ).exists():
            raise ValidationError("此物種名已存在")
        data["genus"] = genus
        return data

    def save(self):
        d = self.cleaned_data
        genus = d["genus"] or Genus.objects.create(name=d["genus_name"], family=d["family"])
        valid = d.get("valid_species")
        return Species.objects.create(
            genus=genus, epithet=d["epithet"], subspecies=d.get("subspecies", ""),
            author=d.get("author", ""), common_name=d.get("common_name", ""),
            valid_species=valid.accepted if valid else None,
        )
